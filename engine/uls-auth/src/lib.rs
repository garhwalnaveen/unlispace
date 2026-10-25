//! Desktop session: the refresh token lives in the macOS Keychain, the access token in memory.
//! Handles proactive refresh (single-flight), refresh-token rotation, drive-token minting and
//! sign-out. Tokens are never logged or put in `Debug` output.

mod error;
mod jwt;
mod pkce;
mod session;
mod store;

pub use error::AuthError;
pub use jwt::{Claims, claims_unverified};
pub use pkce::{DesktopFlow, challenge, random_token};
pub use session::{
    Access, AuthEvent, DriveSummary, DriveToken, DriveTokenSource, Org, Session, SessionTokens, TokenProvider, User,
};
pub use store::{KEYCHAIN_SERVICE, MemoryStore, SecretStore, StoreError, default_store};
#[cfg(target_os = "macos")]
pub use store::KeychainStore;

/// Refresh / re-mint this long before expiry.
pub const REFRESH_MARGIN_MS: u64 = 60_000;
