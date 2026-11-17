import type { Ctx } from "./ctx";
import { HttpError } from "./http";
import { authenticate, type Authed } from "./session";

type Result = Response | Promise<Response>;
export interface Route {
	method: string;
	pattern: RegExp;
	authed: boolean;
	run(ctx: Ctx, params: string[]): Result;
}

/** `/orgs/:org/drives` matches one non-empty path segment per `:name`, passed to the handler in order. */
const compile = (path: string) => new RegExp("^" + path.replace(/:[a-z]+/g, "([^/]+)") + "$");

export const open = (method: string, path: string, run: (ctx: Ctx, params: string[]) => Result): Route => ({ method, pattern: compile(path), authed: false, run });

export const authed = (method: string, path: string, run: (ctx: Ctx, a: Authed, params: string[]) => Result): Route => ({
	method,
	pattern: compile(path),
	authed: true,
	run: async (ctx, params) => run(ctx, await authenticate(ctx), params),
});

/** Unknown paths are 404. A known path with the wrong method is 405, after authentication when the path requires it. */
export async function dispatch(routes: readonly Route[], ctx: Ctx): Promise<Response> {
	const path = ctx.url.pathname.replace(/\/+$/, "") || "/";
	let known: Route | undefined;
	for (const route of routes) {
		const match = route.pattern.exec(path);
		if (!match) continue;
		if (route.method === ctx.req.method) return route.run(ctx, match.slice(1));
		known ??= route;
	}
	if (!known) throw new HttpError(404, "not_found");
	if (known.authed) await authenticate(ctx);
	throw new HttpError(405, "method_not_allowed");
}
