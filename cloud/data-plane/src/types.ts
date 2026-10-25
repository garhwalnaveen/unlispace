export type Ok<T> = { ok: true; data: T };
export type Fail = { ok: false; status: number; body: Record<string, unknown> };
export type Result<T> = Ok<T> | Fail;

export const ok = <T>(data: T): Ok<T> => ({ ok: true, data });
export const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Fail => ({
	ok: false,
	status,
	body: { error, ...extra },
});

export const PLACEMENTS = ["wnam", "enam", "weur", "eeur", "apac", "oc"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** A validated commit operation. `key` is the path without trailing slash ("" is the root). */
export type NormOp =
	| {
			op: "put" | "restore";
			key: string;
			ifVersion: string | null;
			ifAbsent: boolean;
			size: number;
			ctype: string;
			mtimeMs: number;
			/** compact JSON `[[h,n],...]` */
			manifest: string;
			/** hashes referenced, for the shards_known check */
			shards: [string, number][];
	  }
	| { op: "mkdir"; key: string; ifVersion: string | null; ifAbsent: boolean }
	| { op: "delete"; key: string; isFolder: boolean; ifVersion: string | null }
	| { op: "rename"; from: string; to: string; isFolder: boolean; ifVersion: string | null };

export interface CommitResult {
	path: string;
	versionId: string;
	size: number;
}
export interface CommitResponse {
	seq: number;
	results: CommitResult[];
}
export interface ChangeEntry {
	/** event id: the log rowid, unique and increasing per drive */
	ev: number;
	seq: number;
	path: string;
	op: string;
	versionId: string | null;
}
