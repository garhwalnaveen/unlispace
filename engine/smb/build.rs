fn main() {
    println!("cargo:rerun-if-changed=native/mount.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/mount.c")
            .warnings(true)
            .compile("uls_mount");
        println!("cargo:rustc-link-lib=framework=NetFS");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }
}
