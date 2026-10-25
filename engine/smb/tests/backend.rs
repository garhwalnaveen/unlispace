use uls_smb::{ChangeKind, FsError, Kind, MemBackend, SmbBackend};
#[tokio::test]
async fn tree_sparse_io_rename_xattrs_and_events() {
    let b = MemBackend::new();
    let mut events = b.subscribe();
    let a = b.create("f", Kind::File).await.unwrap();
    assert_eq!(events.recv().await.unwrap().kind, ChangeKind::Added);
    b.write("f", 3, b"abc").await.unwrap();
    assert_eq!(&b.read("f", 0, 20).await.unwrap()[..], b"\0\0\0abc");
    assert!(b.read("f", u64::MAX, 10).await.unwrap().is_empty());
    b.set_xattr("f", "com.test", b"value").await.unwrap();
    b.rename("f", "g", false).await.unwrap();
    assert_eq!(b.lookup("g").await.unwrap().id, a.id);
    assert_eq!(b.list_xattr("g").await.unwrap(), ["com.test"]);
    assert_eq!(&b.get_xattr("g", "com.test").await.unwrap()[..], b"value");
    b.remove_xattr("g", "com.test").await.unwrap();
    assert_eq!(b.get_xattr("g", "com.test").await, Err(FsError::NotFound));
    b.truncate("g", 2).await.unwrap();
    b.flush("g").await.unwrap();
    b.remove("g").await.unwrap();
    assert_eq!(b.lookup("g").await, Err(FsError::NotFound));
}
#[tokio::test]
async fn directories_rename_subtree_and_reject_bad_mutations() {
    let b = MemBackend::new();
    for p in ["../bad", "a/../b", "/absolute", "a//b", "a\\b"] {
        assert_eq!(b.create(p, Kind::File).await, Err(FsError::Invalid));
    }
    assert_eq!(
        b.create("missing/f", Kind::File).await,
        Err(FsError::PathNotFound)
    );
    b.create("a", Kind::Directory).await.unwrap();
    b.create("a/b", Kind::Directory).await.unwrap();
    let f = b.create("a/b/f", Kind::File).await.unwrap();
    assert_eq!(b.remove("a").await, Err(FsError::NotEmpty));
    assert_eq!(b.rename("a", "a/b/c", false).await, Err(FsError::Invalid));
    b.rename("a", "z", false).await.unwrap();
    assert_eq!(b.lookup("z/b/f").await.unwrap().id, f.id);
    assert_eq!(b.readdir("z/b").await.unwrap()[0].name, "f");
    assert_eq!(b.write("z", 0, b"bad").await, Err(FsError::IsDirectory));
    assert_eq!(
        b.write("z/b/f", u64::MAX, b"bad").await,
        Err(FsError::NoSpace)
    );
    b.set_metadata("z/b/f", [None; 4], Some(true))
        .await
        .unwrap();
    assert_eq!(
        b.write("z/b/f", 0, b"bad").await,
        Err(FsError::AccessDenied)
    );
}
#[tokio::test]
async fn concurrent_create_has_one_winner() {
    let b = std::sync::Arc::new(MemBackend::new());
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let b = b.clone();
        tasks.spawn(async move { b.create("f", Kind::File).await });
    }
    let mut wins = 0;
    while let Some(r) = tasks.join_next().await {
        match r.unwrap() {
            Ok(_) => wins += 1,
            Err(FsError::Exists) => {}
            Err(e) => panic!("{e}"),
        }
    }
    assert_eq!(wins, 1);
}
