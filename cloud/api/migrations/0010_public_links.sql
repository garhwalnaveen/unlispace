CREATE TABLE public_links (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, drive_id TEXT NOT NULL,
 user_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('download','upload')),
 version_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 revoked_at INTEGER, consumed_at INTEGER, upload_lock TEXT, locked_at INTEGER
);
CREATE INDEX public_links_drive ON public_links(drive_id, user_id);
