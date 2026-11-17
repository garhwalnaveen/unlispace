import { meterUsage } from "./entitlements";
import { pruneExpired } from "./maintenance";
import { rpcContext } from "./control-plane";
export { ControlPlane } from "./control-plane";
import type { AppEnv } from "./env";
import type { Ctx, Deps } from "./ctx";
import { selectSender } from "./email";
import { HttpError, corsHeaders, errBody, json, preflight } from "./http";
import { authRoutes } from "./auth-routes";
import { authed, dispatch, open, type Route } from "./router";
import * as R from "./resources";
import * as K from "./access-keys";
import * as B from "./billing";
import * as T from "./teams";
import * as AI from "./ai";

const routes: Route[] = [
	open("GET", "/healthz", () => json({ ok: true })),
	open("GET", "/client-config", (ctx) => json({ webOrigin: ctx.env.ULS_WEB_ORIGIN })),
	open("GET", "/billing/catalog", (ctx) => B.getCatalog(ctx)),
	open("POST", "/webhooks/dodo", (ctx) => B.webhook(ctx)),
	...authRoutes,

	authed("GET", "/me", (ctx, a) => R.getMe(ctx, a)),
	authed("PATCH", "/me", (ctx, a) => R.patchMe(ctx, a)),
	authed("GET", "/me/access", (ctx, a) => R.getMeAccess(ctx, a)),

	authed("GET", "/orgs", (ctx, a) => R.listOrgs(ctx, a)),
	authed("POST", "/orgs/:org/drives", (ctx, a, [org]) => R.createDrive(ctx, a, org!)),
	authed("GET", "/drives/:drive", (ctx, a, [drive]) => R.getDrive(ctx, a, drive!)),
	authed("PATCH", "/drives/:drive", (ctx, a, [drive]) => R.patchDrive(ctx, a, drive!)),
	authed("DELETE", "/drives/:drive", (ctx, a, [drive]) => R.deleteDrive(ctx, a, drive!)),
	authed("POST", "/drives/:drive/fork", (ctx, a, [drive]) => R.forkDrive(ctx, a, drive!)),
	authed("POST", "/drives/:drive/token", (ctx, a, [drive]) => R.driveToken(ctx, a, drive!)),

	authed("GET", "/keys", (ctx, a) => K.listKeys(ctx, a)),
	authed("POST", "/keys", (ctx, a) => K.createKey(ctx, a)),
	authed("DELETE", "/keys/:key", (ctx, a, [key]) => K.revokeKey(ctx, a, key!)),

	authed("GET", "/orgs/:org/billing", (ctx, a, [org]) => B.getBilling(ctx, a, org!)),
	authed("POST", "/orgs/:org/billing/checkout", (ctx, a, [org]) => B.checkout(ctx, a, org!)),
	authed("GET", "/orgs/:org/billing/invoices", (ctx, a, [org]) => B.invoices(ctx, a, org!)),
	authed("POST", "/orgs/:org/billing/portal", (ctx, a, [org]) => B.portal(ctx, a, org!)),

	authed("GET", "/orgs/:org/members", (ctx, a, [org]) => T.members(ctx, a, org!)),
	authed("PATCH", "/orgs/:org/members/:user", (ctx, a, [org, user]) => T.changeMember(ctx, a, org!, user!)),
	authed("DELETE", "/orgs/:org/members/:user", (ctx, a, [org, user]) => T.changeMember(ctx, a, org!, user!)),
	authed("POST", "/orgs/:org/invites", (ctx, a, [org]) => T.invite(ctx, a, org!)),
	authed("DELETE", "/orgs/:org/invites/:invite", (ctx, a, [org, invite]) => T.revokeInvite(ctx, a, org!, invite!)),
	authed("POST", "/invites/:token/accept", (ctx, a, [token]) => T.acceptInvite(ctx, a, token!)),

	authed("GET", "/ai/models", (ctx, a) => AI.models(ctx, a)),
	authed("POST", "/ai/chat", (ctx, a) => AI.chat(ctx, a)),
];

export async function handle(req: Request, env: AppEnv, deps: Deps = {}): Promise<Response> {
	const cors = corsHeaders(env, req);
	if (req.method === "OPTIONS") return preflight(env, req);
	const f = deps.fetch ?? fetch.bind(globalThis);
	const ctx: Ctx = { env, req, url: new URL(req.url), now: deps.now ? deps.now() : Date.now(), clock: deps.now ?? Date.now, fetch: f, email: deps.email ?? selectSender(env, f), dodo: deps.dodo };
	let res: Response;
	try {
		res = await dispatch(routes, ctx);
	} catch (e) {
		if (e instanceof HttpError) res = json(errBody(e.code, e.message !== e.code ? e.message : undefined), e.status);
		else {
			console.error("unhandled", String((e as Error)?.stack ?? e));
			res = json(errBody("internal"), 500);
		}
	}
	if (Object.keys(cors).length) {
		res = new Response(res.body, res);
		for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
	}
	return res;
}

export default {
	fetch: (req: Request, env: AppEnv): Promise<Response> => handle(req, env),
	scheduled: async (_event: ScheduledController, env: AppEnv) => {
		const ctx = rpcContext(env);
		const results = await Promise.allSettled([meterUsage(ctx), pruneExpired(ctx)]);
		const failure = results.find(r => r.status === "rejected");
		if (failure) throw failure.reason;
	},
} satisfies ExportedHandler<AppEnv>;

