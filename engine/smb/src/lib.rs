#![allow(
    clippy::double_must_use,
    reason = "async_trait macro generates must_use on boxed futures"
)]
//! Loopback SMB adapter for Unlispace.
mod adapter;
mod backend;
mod mem;
mod mount;
mod server;
pub use backend::*;
pub use mem::MemBackend;
pub use mount::{mount, unmount};
pub use server::{RunningServer, serve};

#[cfg(test)]
mod mount_tests {
    use super::*;
    #[test]
    fn mount_rejects_non_loopback_and_zero_port_before_calling_os() {
        for address in ["0.0.0.0:1234", "127.0.0.1:0", "192.0.2.1:445"] {
            assert_eq!(
                mount(address.parse().unwrap(), "user", "password", ".")
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::InvalidInput
            );
        }
    }
}
