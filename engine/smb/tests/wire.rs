//! End-to-end tests against the actual loopback transport and Unlispace backend.
#[path = "../vendor/tests/common/mod.rs"]
mod common;
use common::{auth::*, client::*, crypto::*};
use smb_server::{
    ntstatus::*,
    wire::{header::Command, messages::*},
};
use std::{sync::Arc, time::Duration};
use tokio::net::TcpStream;
use uls_smb::{Kind, MemBackend, SmbBackend};

struct Signed {
    s: TcpStream,
    sid: u64,
    tid: u32,
    key: [u8; 16],
    mid: u64,
}
impl Signed {
    async fn connect(server: &uls_smb::RunningServer) -> Self {
        let mut s = TcpStream::connect(server.addr).await.unwrap();
        let negotiated = common::negotiate_dialects(&mut s, &[0x210]).await;
        assert_eq!(negotiated.security_mode, 3);
        let login = login_with(
            &mut s,
            1,
            0,
            &server.user,
            &server.password,
            LoginOptions::default(),
        )
        .await;
        assert_eq!(login.status, 0);
        let mut c = Self {
            s,
            sid: login.session_id,
            tid: 0,
            key: login.key,
            mid: 3,
        };
        let r = c
            .request(
                Command::TreeConnect,
                &common::tree_connect_body(r"\\127.0.0.1\ULS"),
            )
            .await;
        c.tid = common::parse_response_header(&r).0.tree_id().unwrap();
        c
    }
    async fn send(&mut self, cmd: Command, body: &[u8]) -> Vec<u8> {
        let hdr = common::build_header(cmd, self.mid, self.sid, self.tid);
        self.mid += 1;
        send(&mut self.s, hdr, body, Some(&self.key)).await
    }
    async fn request(&mut self, cmd: Command, body: &[u8]) -> Vec<u8> {
        let r = self.send(cmd, body).await;
        assert_eq!(status(&r), 0, "{cmd:?}: {:#x}", status(&r));
        assert_eq!(r[48..64], common::smb2_signature(&r, &self.key));
        r
    }
    async fn create(&mut self, c: Create<'_>) -> FileId {
        let r = self.request(Command::Create, &c.body()).await;
        CreateResponse::parse(&r[64..]).unwrap().file_id
    }
    async fn close(&mut self, id: FileId) {
        let mut body = Vec::new();
        CloseRequest {
            structure_size: 24,
            flags: 0,
            reserved: 0,
            file_id: id,
        }
        .write_to(&mut body)
        .unwrap();
        self.request(Command::Close, &body).await;
    }
}
fn encode_write(id: FileId, off: u64, data: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    write_request(id, off, data).write_to(&mut b).unwrap();
    b
}
fn encode_read(id: FileId, off: u64, len: u32) -> Vec<u8> {
    let mut b = Vec::new();
    ReadRequest {
        structure_size: 49,
        padding: 0,
        flags: 0,
        length: len,
        offset: off,
        file_id: id,
        minimum_count: 0,
        channel: 0,
        remaining_bytes: 0,
        read_channel_info_offset: 0,
        read_channel_info_length: 0,
        buffer: vec![0],
    }
    .write_to(&mut b)
    .unwrap();
    b
}
fn query(id: FileId, info_type: InfoType, class: u8) -> Vec<u8> {
    let mut b = Vec::new();
    QueryInfoRequest {
        structure_size: 41,
        info_type: info_type as u8,
        file_information_class: class,
        output_buffer_length: 65536,
        input_buffer_offset: 0,
        reserved: 0,
        input_buffer_length: 0,
        additional_information: 0,
        flags: 0,
        file_id: id,
        input_buffer: vec![],
    }
    .write_to(&mut b)
    .unwrap();
    b
}
#[tokio::test]
async fn signed_io_streams_metadata_and_backend_notify() {
    let b = Arc::new(MemBackend::new());
    let server = uls_smb::serve(b.clone(), false).await.unwrap();
    let mut c = Signed::connect(&server).await;
    let file = c
        .create(Create {
            name: "f",
            disposition: FILE_CREATE,
            access: FILE_ALL_ACCESS,
            ..Create::default()
        })
        .await;
    c.request(Command::Write, &encode_write(file, 0, b"contents"))
        .await;
    let r = c.request(Command::Read, &encode_read(file, 0, 8)).await;
    assert_eq!(ReadResponse::parse(&r[64..]).unwrap().data, b"contents");
    let stream = c
        .create(Create {
            name: "f:com.test:$DATA",
            disposition: FILE_OPEN_IF,
            access: FILE_ALL_ACCESS,
            ..Create::default()
        })
        .await;
    c.request(Command::Write, &encode_write(stream, 0, b"x"))
        .await;
    c.close(stream).await;
    assert_eq!(&b.get_xattr("f", "com.test").await.unwrap()[..], b"x");
    let afp = c
        .create(Create {
            name: "f:AFP_AfpInfo:$DATA",
            disposition: FILE_OPEN_IF,
            ..Create::default()
        })
        .await;
    let r = c.request(Command::Read, &encode_read(afp, 0, 60)).await;
    let mut data = ReadResponse::parse(&r[64..]).unwrap().data;
    assert_eq!(&data[..4], b"AFP\0");
    data[16..48].fill(0x41);
    c.request(Command::Write, &encode_write(afp, 0, &data))
        .await;
    c.close(afp).await;
    assert_eq!(
        &b.get_xattr("f", "com.apple.FinderInfo").await.unwrap()[..],
        &[0x41; 32]
    );
    for class in [4, 5, 6, 7, 8, 14, 16, 17, 18, 22, 34] {
        c.request(Command::QueryInfo, &query(file, InfoType::File, class))
            .await;
    }
    c.close(file).await;
    let root = c
        .create(Create {
            options: FILE_DIRECTORY_FILE,
            access: FILE_GENERIC_READ,
            ..Create::default()
        })
        .await;
    for class in [1, 3, 4, 5, 7, 11] {
        c.request(
            Command::QueryInfo,
            &query(root, InfoType::FileSystem, class),
        )
        .await;
    }
    let notify = common::notify::notify_body(root, 4096, 0x1, false);
    let interim = c.send(Command::ChangeNotify, &notify).await;
    assert_eq!(status(&interim), STATUS_PENDING);
    let start = std::time::Instant::now();
    b.create("arrival", Kind::File).await.unwrap();
    let r = tokio::time::timeout(Duration::from_secs(2), common::read_frame(&mut c.s))
        .await
        .unwrap();
    assert_eq!(status(&r), 0);
    assert_eq!(r[48..64], common::smb2_signature(&r, &c.key));
    assert_eq!(
        common::notify::notify_entries(&r[64..], 4096),
        [(1, "arrival".into())]
    );
    assert!(start.elapsed() < Duration::from_secs(2));
    c.close(root).await;
    drop(c);
    server.shutdown().await.unwrap();
}
#[tokio::test]
async fn encrypted_smb302_and_smb311_gcm_backend_io() {
    for (dialect, cipher) in [(0x302, Cipher::Aes128Ccm), (0x311, Cipher::Aes128Gcm)] {
        let b = Arc::new(MemBackend::new());
        let server = uls_smb::serve(b.clone(), true).await.unwrap();
        let mut c = if dialect == 0x302 {
            EncryptedSession::smb30(server.addr, dialect, &server.user, &server.password).await
        } else {
            EncryptedSession::smb311(server.addr, &[cipher], &server.user, &server.password).await
        };
        assert_eq!(c.cipher, cipher);
        assert_ne!(c.session_flags() & 4, 0);
        let r = c.tree_connect(r"\\127.0.0.1\ULS").await;
        assert_eq!(status(&r), 0);
        let r = c
            .send_encrypted(
                Command::Create,
                &Create {
                    name: "encrypted",
                    disposition: FILE_CREATE,
                    ..Create::default()
                }
                .body(),
            )
            .await;
        assert_eq!(status(&r), 0);
        let id = CreateResponse::parse(&r[64..]).unwrap().file_id;
        let r = c
            .send_encrypted(Command::Write, &encode_write(id, 0, b"secret bytes"))
            .await;
        assert_eq!(status(&r), 0);
        let r = c
            .send_encrypted(Command::Read, &encode_read(id, 0, 12))
            .await;
        assert_eq!(status(&r), 0);
        assert_eq!(ReadResponse::parse(&r[64..]).unwrap().data, b"secret bytes");
        assert_eq!(
            &b.read("encrypted", 0, 12).await.unwrap()[..],
            b"secret bytes"
        );
        drop(c);
        server.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn signed_fifty_mib_round_trip_and_locks() {
    use sha2::{Digest, Sha256};
    let b = Arc::new(MemBackend::new());
    let server = uls_smb::serve(b.clone(), false).await.unwrap();
    let mut c = Signed::connect(&server).await;
    let id = c
        .create(Create {
            name: "large",
            disposition: FILE_CREATE,
            ..Create::default()
        })
        .await;
    let chunk: Vec<_> = (0..65536).map(|n| (n % 251) as u8).collect();
    let mut written = Sha256::new();
    for i in 0..800u64 {
        c.request(Command::Write, &encode_write(id, i * 65536, &chunk))
            .await;
        written.update(&chunk);
    }
    let mut read = Sha256::new();
    for i in 0..800u64 {
        let r = c
            .request(Command::Read, &encode_read(id, i * 65536, 65536))
            .await;
        read.update(&ReadResponse::parse(&r[64..]).unwrap().data);
    }
    assert_eq!(written.finalize(), read.finalize());
    assert_eq!(b.lookup("large").await.unwrap().size, 50 * 1024 * 1024);
    let mut other = Signed::connect(&server).await;
    let second = other
        .create(Create {
            name: "large",
            ..Create::default()
        })
        .await;
    let lock = |id, flags| {
        let mut b = Vec::new();
        LockRequest {
            structure_size: 48,
            lock_count: 1,
            lock_sequence: 0,
            file_id: id,
            locks: vec![LockElement {
                offset: 0,
                length: 128,
                flags,
                reserved: 0,
            }],
        }
        .write_to(&mut b)
        .unwrap();
        b
    };
    c.request(Command::Lock, &lock(id, 2 | 0x10)).await;
    let r = other.send(Command::Lock, &lock(second, 2 | 0x10)).await;
    assert_eq!(status(&r), STATUS_LOCK_NOT_GRANTED);
    let r = other.send(Command::Write, &encode_write(second, 0, b"denied")).await;
    assert_eq!(status(&r), STATUS_FILE_LOCK_CONFLICT);
    c.request(Command::Lock, &lock(id, 4)).await;
    other.request(Command::Lock, &lock(second, 2 | 0x10)).await;
    other.close(second).await;
    c.request(Command::Lock, &lock(id, 2 | 0x10)).await;
    drop(other);
    c.close(id).await;
    drop(c);
    server.shutdown().await.unwrap();
}
#[tokio::test]
async fn wrong_password_and_anonymous_are_denied() {
    let server = uls_smb::serve(Arc::new(MemBackend::new()), false)
        .await
        .unwrap();
    let mut s = TcpStream::connect(server.addr).await.unwrap();
    assert_eq!(
        common::negotiate_dialects(&mut s, &[0x210])
            .await
            .security_mode,
        3
    );
    let login = login_with(&mut s, 1, 0, &server.user, "wrong", LoginOptions::default()).await;
    assert_eq!(login.status, STATUS_LOGON_FAILURE);
    drop(s);
    let mut s = TcpStream::connect(server.addr).await.unwrap();
    assert_eq!(
        common::negotiate_dialects(&mut s, &[0x210])
            .await
            .security_mode,
        3
    );
    let (initial, sid) = common::start_ntlm_session_setup(&mut s, 1).await;
    assert_eq!(initial, STATUS_MORE_PROCESSING_REQUIRED);
    assert_eq!(
        common::finish_anonymous_session_setup(&mut s, 2, sid).await,
        STATUS_LOGON_FAILURE
    );
    drop(s);
    server.shutdown().await.unwrap();
}

fn set_info(id: FileId, class: u8, buffer: Vec<u8>) -> Vec<u8> {
    let mut b = Vec::new();
    SetInfoRequest {
        structure_size: 33,
        info_type: 1,
        file_information_class: class,
        buffer_length: buffer.len() as u32,
        buffer_offset: 96,
        reserved: 0,
        additional_information: 0,
        file_id: id,
        buffer,
    }
    .write_to(&mut b)
    .unwrap();
    b
}
#[tokio::test]
async fn signed_dispositions_rename_delete_directory_and_resource_stream() {
    let b = Arc::new(MemBackend::new());
    let server = uls_smb::serve(b.clone(), false).await.unwrap();
    let mut c = Signed::connect(&server).await;
    for name in ["a", "a/b", "a/b/c"] {
        let id = c
            .create(Create {
                name,
                disposition: FILE_OPEN_IF,
                options: FILE_DIRECTORY_FILE,
                ..Create::default()
            })
            .await;
        c.close(id).await;
    }
    for disposition in [
        FILE_CREATE,
        FILE_OPEN,
        FILE_OPEN_IF,
        FILE_OVERWRITE,
        FILE_OVERWRITE_IF,
        FILE_SUPERSEDE,
    ] {
        let id = c
            .create(Create {
                name: "a/b/c/f",
                disposition,
                access: FILE_ALL_ACCESS,
                ..Create::default()
            })
            .await;
        c.request(Command::Write, &encode_write(id, 0, b"copy bytes"))
            .await;
        let mut flush = Vec::new();
        FlushRequest::new(id.persistent, id.volatile)
            .write_to(&mut flush)
            .unwrap();
        c.request(Command::Flush, &flush).await;
        c.request(
            Command::SetInfo,
            &set_info(
                id,
                FILE_END_OF_FILE_INFORMATION,
                5u64.to_le_bytes().to_vec(),
            ),
        )
        .await;
        assert_eq!(b.lookup("a/b/c/f").await.unwrap().size, 5);
        c.request(
            Command::SetInfo,
            &set_info(
                id,
                FILE_ALLOCATION_INFORMATION,
                4096u64.to_le_bytes().to_vec(),
            ),
        )
        .await;
        let mut basic = vec![0; 40];
        basic[16..24].copy_from_slice(&132000000000000000u64.to_le_bytes());
        c.request(
            Command::SetInfo,
            &set_info(id, FILE_BASIC_INFORMATION, basic),
        )
        .await;
        c.close(id).await;
    }
    let id = c
        .create(Create {
            name: "a/b/c/f",
            access: FILE_ALL_ACCESS,
            ..Create::default()
        })
        .await;
    let resource = c
        .create(Create {
            name: "a/b/c/f:AFP_Resource:$DATA",
            disposition: FILE_CREATE,
            access: FILE_ALL_ACCESS,
            ..Create::default()
        })
        .await;
    c.request(Command::Write, &encode_write(resource, 0, b"resource"))
        .await;
    assert_eq!(
        &b.get_xattr("a/b/c/f", "com.apple.ResourceFork")
            .await
            .unwrap()[..],
        b"resource"
    );
    c.request(
        Command::SetInfo,
        &set_info(resource, FILE_DISPOSITION_INFORMATION, vec![1]),
    )
    .await;
    c.close(resource).await;
    assert!(
        b.get_xattr("a/b/c/f", "com.apple.ResourceFork")
            .await
            .is_err()
    );
    // MS-FSCC FileRenameInformation has an 8-byte RootDirectory at offset 8
    // and FileNameLength at 16, then the name at 20.
    let name = common::utf16le("a/b/c/moved");
    let mut rename = vec![0; 20];
    rename[0] = 1;
    rename[16..20].copy_from_slice(&(name.len() as u32).to_le_bytes());
    rename.extend(name);
    c.request(
        Command::SetInfo,
        &set_info(id, FILE_RENAME_INFORMATION, rename),
    )
    .await;
    assert_eq!(&b.read("a/b/c/moved", 0, 20).await.unwrap()[..], b"copy ");
    c.request(
        Command::SetInfo,
        &set_info(id, FILE_DISPOSITION_INFORMATION, vec![1]),
    )
    .await;
    c.close(id).await;
    assert!(b.lookup("a/b/c/moved").await.is_err());
    let dir = c
        .create(Create {
            name: "a/b",
            options: FILE_DIRECTORY_FILE,
            access: FILE_GENERIC_READ,
            ..Create::default()
        })
        .await;
    let mut body = Vec::new();
    QueryDirectoryRequest {
        structure_size: 33,
        file_information_class: 37,
        flags: 1,
        file_index: 0,
        file_id: dir,
        file_name_offset: 96,
        file_name_length: 2,
        output_buffer_length: 65536,
        file_name: common::utf16le("*"),
    }
    .write_to(&mut body)
    .unwrap();
    let r = c.request(Command::QueryDirectory, &body).await;
    let entries = QueryDirectoryResponse::parse(&r[64..]).unwrap().buffer;
    assert!(common::id_both_entries(&entries).iter().any(|e| e.0 == "c"));
    c.close(dir).await;
    let mut body = Vec::new();
    EchoRequest::default().write_to(&mut body).unwrap();
    c.request(Command::Echo, &body).await;
    drop(c);
    server.shutdown().await.unwrap();
}

struct FailingFlush {
    inner: MemBackend,
    calls: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl SmbBackend for FailingFlush {
    async fn lookup(&self, p: &str) -> Result<uls_smb::Attr, uls_smb::FsError> {
        self.inner.lookup(p).await
    }
    async fn readdir(&self, p: &str) -> Result<Vec<uls_smb::DirEntry>, uls_smb::FsError> {
        self.inner.readdir(p).await
    }
    async fn read(&self, p: &str, o: u64, l: u32) -> Result<bytes::Bytes, uls_smb::FsError> {
        self.inner.read(p, o, l).await
    }
    async fn create(&self, p: &str, k: Kind) -> Result<uls_smb::Attr, uls_smb::FsError> {
        self.inner.create(p, k).await
    }
    async fn write(&self, p: &str, o: u64, d: &[u8]) -> Result<u32, uls_smb::FsError> {
        self.inner.write(p, o, d).await
    }
    async fn truncate(&self, p: &str, l: u64) -> Result<(), uls_smb::FsError> {
        self.inner.truncate(p, l).await
    }
    async fn rename(&self, f: &str, t: &str, r: bool) -> Result<(), uls_smb::FsError> {
        self.inner.rename(f, t, r).await
    }
    async fn remove(&self, p: &str) -> Result<(), uls_smb::FsError> {
        self.inner.remove(p).await
    }
    async fn get_xattr(&self, p: &str, n: &str) -> Result<bytes::Bytes, uls_smb::FsError> {
        self.inner.get_xattr(p, n).await
    }
    async fn set_xattr(&self, p: &str, n: &str, d: &[u8]) -> Result<(), uls_smb::FsError> {
        self.inner.set_xattr(p, n, d).await
    }
    async fn list_xattr(&self, p: &str) -> Result<Vec<String>, uls_smb::FsError> {
        self.inner.list_xattr(p).await
    }
    async fn remove_xattr(&self, p: &str, n: &str) -> Result<(), uls_smb::FsError> {
        self.inner.remove_xattr(p, n).await
    }
    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<uls_smb::ChangeEvent> {
        self.inner.subscribe()
    }
    async fn flush(&self, _: &str) -> Result<(), uls_smb::FsError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(uls_smb::FsError::Io(
            "injected durable flush failure".into(),
        ))
    }
}
#[tokio::test]
async fn close_and_explicit_flush_report_backend_commit_failure() {
    let b = Arc::new(FailingFlush {
        inner: MemBackend::new(),
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    let server = uls_smb::serve(b.clone(), false).await.unwrap();
    let mut c = Signed::connect(&server).await;
    let id = c
        .create(Create {
            name: "f",
            disposition: FILE_CREATE,
            ..Create::default()
        })
        .await;
    c.request(Command::Write, &encode_write(id, 0, b"not committed"))
        .await;
    let mut body = Vec::new();
    FlushRequest::new(id.persistent, id.volatile)
        .write_to(&mut body)
        .unwrap();
    assert_eq!(
        status(&c.send(Command::Flush, &body).await),
        STATUS_UNEXPECTED_IO_ERROR
    );
    body.clear();
    CloseRequest {
        structure_size: 24,
        flags: 0,
        reserved: 0,
        file_id: id,
    }
    .write_to(&mut body)
    .unwrap();
    assert_eq!(
        status(&c.send(Command::Close, &body).await),
        STATUS_UNEXPECTED_IO_ERROR
    );
    assert_eq!(b.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(&b.read("f", 0, 20).await.unwrap()[..], b"not committed");
    let id = c
        .create(Create {
            name: "f",
            ..Create::default()
        })
        .await;
    c.request(
        Command::SetInfo,
        &set_info(
            id,
            FILE_END_OF_FILE_INFORMATION,
            3u64.to_le_bytes().to_vec(),
        ),
    )
    .await;
    body.clear();
    CloseRequest {
        structure_size: 24,
        flags: 0,
        reserved: 0,
        file_id: id,
    }
    .write_to(&mut body)
    .unwrap();
    assert_eq!(
        status(&c.send(Command::Close, &body).await),
        STATUS_UNEXPECTED_IO_ERROR
    );
    assert_eq!(b.calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    drop(c);
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn signed_mac_style_stream_compounds_secure_negotiate_and_cancel() {
    use smb_server::wire::header::{
        HeaderTail, SMB2_FLAGS_ASYNC_COMMAND, SMB2_FLAGS_RELATED_OPERATIONS, SMB2_FLAGS_SIGNED,
    };
    use tokio::io::AsyncWriteExt;
    let b = Arc::new(MemBackend::new());
    b.create("f", Kind::File).await.unwrap();
    let server = uls_smb::serve(b.clone(), false).await.unwrap();
    let mut c = Signed::connect(&server).await;
    let input = validate_negotiate_input(0, common::CLIENT_GUID, 1, &[0x210]);
    c.request(
        Command::Ioctl,
        &ioctl_body(Fsctl::VALIDATE_NEGOTIATE_INFO, FileId::any(), &input, 24, 1),
    )
    .await;
    for value in [b"longer value".as_slice(), b"x".as_slice()] {
        let create = Create {
            name: "f:com.test",
            disposition: FILE_OVERWRITE_IF,
            access: FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES,
            options: 0,
            share: SHARE_READ | SHARE_DELETE,
            ..Create::default()
        }
        .body();
        let mut close = Vec::new();
        CloseRequest {
            structure_size: 24,
            flags: 0,
            reserved: 0,
            file_id: FileId::any(),
        }
        .write_to(&mut close)
        .unwrap();
        let mut messages = Vec::new();
        let mut basic = vec![0; 40];
        basic[16..24].copy_from_slice(&132_000_000_000_000_000u64.to_le_bytes());
        for (index, (command, body)) in [
            (Command::Create, create),
            (Command::Write, encode_write(FileId::any(), 0, value)),
            (Command::SetInfo, set_info(FileId::any(), 4, basic)),
            (Command::Close, close),
        ]
        .iter()
        .enumerate()
        {
            let mut h = common::build_header(*command, c.mid, c.sid, c.tid);
            c.mid += 1;
            h.flags |= SMB2_FLAGS_SIGNED;
            if index > 0 {
                h.flags |= SMB2_FLAGS_RELATED_OPERATIONS;
            }
            messages.push(common::message(&h, body));
        }
        let mut compound = common::transport::compound(&messages)[4..].to_vec();
        let mut offset = 0;
        loop {
            let (h, _) = smb_server::wire::header::Smb2Header::parse(&compound[offset..]).unwrap();
            let len = if h.next_command == 0 {
                compound.len() - offset
            } else {
                h.next_command as usize
            };
            let signature = common::smb2_signature(&compound[offset..offset + len], &c.key);
            compound[offset + 48..offset + 64].copy_from_slice(&signature);
            if h.next_command == 0 {
                break;
            }
            offset += len;
        }
        c.s.write_all(&common::framed(&compound)).await.unwrap();
        let reply = common::read_frame(&mut c.s).await;
        let mut offset = 0;
        let mut count = 0;
        loop {
            let (h, _) = common::parse_response_header(&reply[offset..]);
            assert_eq!(h.channel_sequence_status, 0);
            let len = if h.next_command == 0 {
                reply.len() - offset
            } else {
                h.next_command as usize
            };
            assert_eq!(
                reply[offset + 48..offset + 64],
                common::smb2_signature(&reply[offset..offset + len], &c.key)
            );
            count += 1;
            if h.next_command == 0 {
                break;
            }
            offset += len;
        }
        assert_eq!(count, 4);
        assert_eq!(&b.get_xattr("f", "com.test").await.unwrap()[..], value);
        assert_eq!(b.lookup("f").await.unwrap().modified, 132_000_000_000_000_000);
    }
    let resource = c.create(Create {
        name: "f:AFP_Resource",
        disposition: FILE_OPEN_IF,
        access: FILE_WRITE_DATA,
        share: SHARE_READ | SHARE_DELETE,
        ..Create::default()
    }).await;
    c.request(Command::Write, &encode_write(resource, 0, b"resource fork")).await;
    c.close(resource).await;
    assert_eq!(&b.get_xattr("f", "com.apple.ResourceFork").await.unwrap()[..], b"resource fork");
    let root = c
        .create(Create {
            options: FILE_DIRECTORY_FILE,
            access: FILE_GENERIC_READ,
            ..Create::default()
        })
        .await;
    let fs = c.request(Command::QueryInfo, &query(root, InfoType::FileSystem, 5)).await;
    let fs = QueryInfoResponse::parse(&fs[64..]).unwrap();
    let attributes = u32::from_le_bytes(fs.buffer[..4].try_into().unwrap());
    assert_eq!(attributes, 0x0004_0007, "named streams, no native EAs");
    let original = c.mid;
    let interim = c
        .send(
            Command::ChangeNotify,
            &common::notify::notify_body(root, 4096, 1, false),
        )
        .await;
    assert_eq!(status(&interim), STATUS_PENDING);
    let async_id = common::parse_response_header(&interim)
        .0
        .async_id()
        .unwrap();
    let mut header = common::build_header(Command::Cancel, original, c.sid, c.tid);
    header.flags |= SMB2_FLAGS_ASYNC_COMMAND;
    header.tail = HeaderTail::async_(async_id);
    let mut body = Vec::new();
    CancelRequest::default().write_to(&mut body).unwrap();
    let response = tokio::time::timeout(
        Duration::from_secs(2),
        send(&mut c.s, header, &body, Some(&c.key)),
    )
    .await
    .unwrap();
    assert_eq!(status(&response), STATUS_CANCELLED);
    c.close(root).await;
    drop(c);
    server.shutdown().await.unwrap();
}
