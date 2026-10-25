import type { AppEnv } from "./env";
import type { EmailSender } from "./email";
import { createUlid } from "./ulid";

export interface Deps {
	now?: () => number;
	fetch?: typeof fetch;
	email?: EmailSender;
}

export interface Ctx {
	env: AppEnv;
	req: Request;
	url: URL;
	now: number;
	fetch: typeof fetch;
	email: EmailSender;
}

const gen = createUlid();
export const ulid = (): string => gen();

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
