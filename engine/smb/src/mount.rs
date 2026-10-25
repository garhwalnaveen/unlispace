//! macOS mounting with in-memory credentials, without password-bearing argv.
use std::{io, net::SocketAddr, path::Path};

pub fn mount(
    addr: SocketAddr,
    user: &str,
    pass: &str,
    mountpoint: impl AsRef<Path>,
) -> io::Result<()> {
    if addr.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) || addr.port() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected 127.0.0.1 and a nonzero port",
        ));
    }
    if user.is_empty() || user.contains('\0') || pass.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid credentials",
        ));
    }
    let path = std::fs::canonicalize(mountpoint)?;
    if !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mountpoint must be a directory",
        ));
    }
    mount_platform(addr, user, pass, &path)
}
#[cfg(target_os = "macos")]
fn mount_platform(addr: SocketAddr, user: &str, pass: &str, path: &Path) -> io::Result<()> {
    use std::ffi::CString;
    unsafe extern "C" {
        fn uls_open_session(
            url: *const std::ffi::c_char,
            connection: *mut *mut std::ffi::c_void,
        ) -> std::ffi::c_int;
        fn uls_release_session(connection: *mut std::ffi::c_void);
    }
    let encode = |s: &str| {
        s.as_bytes()
            .iter()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-._~".contains(b) {
                    (*b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>()
    };
    let user = encode(user);
    let pass = encode(pass);
    let url = CString::new(format!("//{user}:{pass}@{addr}/ULS"))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL"))?;
    let mut connection = std::ptr::null_mut();
    // SAFETY: the API borrows the C string synchronously and initializes the out handle.
    let status = unsafe { uls_open_session(url.as_ptr(), &mut connection) };
    if status != 0 {
        return Err(io::Error::other(format!(
            "SMBOpenServerEx: {}",
            io::Error::from_raw_os_error(status)
        )));
    }
    let output = std::process::Command::new("/sbin/mount_smbfs")
        .args(["-N", "-o", "soft"])
        .arg(format!("//{user}@{addr}/ULS"))
        .arg(path)
        .output();
    // SAFETY: release exactly the successful session handle after the child reuses it.
    unsafe { uls_release_session(connection) };
    let output = output?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}
#[cfg(not(target_os = "macos"))]
fn mount_platform(_: SocketAddr, _: &str, _: &str, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "mount requires macOS",
    ))
}

pub fn unmount(mountpoint: impl AsRef<Path>) -> io::Result<()> {
    let path = std::fs::canonicalize(mountpoint)?;
    let output = std::process::Command::new("/sbin/umount")
        .arg(&path)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}
