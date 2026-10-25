import type { AppEnv } from "./env";

export interface EmailSender {
	send(to: string, subject: string, text: string, html?: string): Promise<void>;
}

/** Dev only (ULS_DEV_LOG_OTP=1): prints the message instead of sending it. */
export class ConsoleSender implements EmailSender {
	async send(to: string, subject: string, text: string): Promise<void> {
		console.log(`[email:dev] to=${to} subject=${subject}\n${text}`);
	}
}

/** Cloudflare Email Service `send_email` binding (Workers binding API). */
export class CloudflareEmailSender implements EmailSender {
	constructor(private binding: SendEmail, private from: string) {}
	async send(to: string, subject: string, text: string, html?: string): Promise<void> {
		await this.binding.send({ to, from: { email: this.from, name: "Unlispace" }, subject, text, ...(html ? { html } : {}) });
	}
}

/** Resend HTTP API fallback. */
export class ResendSender implements EmailSender {
	constructor(private apiKey: string, private from: string, private fetcher: typeof fetch) {}
	async send(to: string, subject: string, text: string, html?: string): Promise<void> {
		const res = await this.fetcher("https://api.resend.com/emails", {
			method: "POST",
			headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ from: `Unlispace <${this.from}>`, to: [to], subject, text, ...(html ? { html } : {}) }),
		});
		if (!res.ok) throw new Error(`resend ${res.status}`);
	}
}

export class NoEmailSender implements EmailSender {
	async send(): Promise<void> {
		throw new Error("no email sender configured (set ULS_DEV_LOG_OTP=1, RESEND_API_KEY, or bind EMAIL)");
	}
}

/** Order: dev console, then Resend if RESEND_API_KEY is set, then the Cloudflare binding. */
export function selectSender(env: AppEnv, fetcher: typeof fetch): EmailSender {
	const from = env.ULS_EMAIL_FROM || "login@unlispace.com";
	if (env.ULS_DEV_LOG_OTP === "1") return new ConsoleSender();
	if (env.RESEND_API_KEY) return new ResendSender(env.RESEND_API_KEY, from, fetcher);
	if (env.EMAIL) return new CloudflareEmailSender(env.EMAIL, from);
	return new NoEmailSender();
}
