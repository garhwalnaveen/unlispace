/** Placement values accepted by the data plane (see cloud/data-plane/src/types.ts). */
export type Placement = "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";
export const PLACEMENTS: readonly Placement[] = ["wnam", "enam", "weur", "eeur", "apac", "oc"];

/** RPC surface of the data plane's `DataPlaneAdmin` WorkerEntrypoint (contract section 4). */
export interface DataPlaneAdmin {
	createDrive(driveId: string, placement?: Placement | null): Promise<{ driveId: string; placement: string | null; createdAt: number }>;
	forkDrive(sourceId: string, newId: string): Promise<{driveId: string; sourceId: string; lineage: string; forkSeq: number; forkPoint: number; placement: string | null}>;
	deleteDrive(driveId: string, opts?: {hard?: boolean}): Promise<{ ok: true }>;
	driveStats(driveId: string): Promise<{ headSeq: number; fileCount: number; bytes: number; ownBytes: number; lineage: string; depth: number; forkOf: {driveId: string; forkPoint: number} | null } | null>;
}

export interface AppEnv {
	DB: D1Database;
	DATA_PLANE: DataPlaneAdmin;
	/** Cloudflare Email Service binding (optional so tests / dev can omit it). */
	EMAIL?: SendEmail;
	ULS_JWT_PRIVATE_JWK: string;
	ULS_JWT_PUBLIC_JWKS: string;
	ULS_ISSUER: string;
	ULS_DATA_ENDPOINT: string;
	ULS_WEB_ORIGIN: string;
	ULS_DEV_LOG_OTP?: string;
	/** Sender address for OTP mail, default login@unlispace.com. */
	ULS_EMAIL_FROM?: string;
	RESEND_API_KEY?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** JSON object of version character -> base64-encoded master (at least 32 bytes). */
	ULS_ACCESS_KEY_MASTERS?: string;
	ULS_ACCESS_KEY_VERSION?: string;
	DODO_PAYMENTS_API_KEY?: string;
	DODO_PAYMENTS_WEBHOOK_KEY?: string;
	DODO_PAYMENTS_ENVIRONMENT?: "test_mode" | "live_mode";
	/** JSON BillingProducts: recurring seat product IDs plus recurring storage addon IDs. */
	DODO_PRODUCTS?: string;
}
