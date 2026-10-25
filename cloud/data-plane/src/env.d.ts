// Bindings that are not declared in wrangler.jsonc (so `wrangler types` does not emit them).
interface Env {
	ULS_WEB_ORIGINS?: string;
	/** Static M0 bearer. Only read when ULS_ALLOW_DEV_TOKEN === "1". Local: .dev.vars. */
	ULS_DEV_TOKEN?: string;
	/** Delete unreferenced shards only when explicitly set to 1; dry-run otherwise. */
	ULS_GC_DELETE?: string;
}
