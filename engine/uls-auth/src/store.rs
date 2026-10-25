//! Where the refresh token lives. The macOS Keychain in production, memory in tests.

use std::collections::HashMap;
use std::sync::Mutex;

/// Keychain service name for the refresh token item.
pub const KEYCHAIN_SERVICE: &str = "com.unlispace.ulsd";

#[derive(Debug, thiserror::Error)]
#[error("secret store: {0}")]
pub struct StoreError(pub String);

/// A tiny keyed secret store. `account` is the user id.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError>;
    /// Insert or replace.
    fn set(&self, account: &str, secret: &str) -> Result<(), StoreError>;
    /// Deleting a missing item is not an error.
    fn delete(&self, account: &str) -> Result<(), StoreError>;
}

/// In-memory store for tests and non-macOS builds.
#[derive(Default)]
pub struct MemoryStore {
    items: Mutex<HashMap<String, String>>,
    /// Number of successful `set` calls (lets tests assert rotation was persisted).
    sets: std::sync::atomic::AtomicUsize,
}

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }

    pub fn set_count(&self) -> usize {
        self.sets.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn items(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.items.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        Ok(self.items().get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), StoreError> {
        self.items().insert(account.to_string(), secret.to_string());
        self.sets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.items().remove(account);
        Ok(())
    }
}

/// macOS Keychain: generic password, service `com.unlispace.ulsd`, account = user id.
#[cfg(target_os = "macos")]
pub struct KeychainStore {
    service: String,
}

#[cfg(target_os = "macos")]
impl KeychainStore {
    pub fn new() -> KeychainStore {
        KeychainStore { service: KEYCHAIN_SERVICE.to_string() }
    }

    /// Use a different service name (tests that touch the real Keychain must not clobber the real item).
    pub fn with_service(service: impl Into<String>) -> KeychainStore {
        KeychainStore { service: service.into() }
    }
}

#[cfg(target_os = "macos")]
impl Default for KeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

/// `errSecItemNotFound`
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(&self.service, account) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| StoreError("keychain item is not UTF-8".into())),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(StoreError(format!("keychain read failed ({})", e.code()))),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), StoreError> {
        // Adds the item, or updates it in place if it already exists (SecItemUpdate), so a
        // rotation never leaves a window with no stored token.
        security_framework::passwords::set_generic_password(&self.service, account, secret.as_bytes())
            .map_err(|e| StoreError(format!("keychain write failed ({})", e.code())))
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        match security_framework::passwords::delete_generic_password(&self.service, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(StoreError(format!("keychain delete failed ({})", e.code()))),
        }
    }
}

/// The store the daemon uses: Keychain on macOS, memory elsewhere.
pub fn default_store() -> std::sync::Arc<dyn SecretStore> {
    #[cfg(target_os = "macos")]
    {
        std::sync::Arc::new(KeychainStore::new())
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::sync::Arc::new(MemoryStore::new())
    }
}
