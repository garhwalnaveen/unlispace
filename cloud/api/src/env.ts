/** Placement values accepted by the data plane (see cloud/data-plane/src/types.ts). */
export type Placement = "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";
export const PLACEMENTS: readonly Placement[] = ["wnam", "enam", "weur", "eeur", "apac", "oc"];

/** RPC surface of the data plane's `DataPlaneAdmin` WorkerEntrypoint (contract section 4). */
export interface DataPlaneAdmin {
	createDrive(driveId: string, placement?: Placement | null): Promise<{ driveId: string; placement: string | null; createdAt: number }>;
	deleteDrive(driveId: string): Promise<{ ok: true }>;
	driveStats(driveId: string): Promise<{ headSeq: number; fileCount: number; bytes: number } | null>;
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
}
