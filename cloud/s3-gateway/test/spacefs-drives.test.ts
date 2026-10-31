import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { bucketName, harness, rawSigned } from "./helpers";

describe("SpaceFS drive wire compatibility", () => {
	it("forks annotations by reference without scanning history and preserves inherited operations",async()=>{
		const h=await harness(),parent=bucketName(),child=bucketName(),grandchild=bucketName();
		const call=async(method:string,path:string,headers:Record<string,string>={},body?:string)=>handle(await rawSigned(h,method,path,{headers,body}),h.deps);
		expect((await call("PUT",`/${parent}`)).status).toBe(200);
		await call("PUT",`/${parent}/f`,{},"base");
		await call("PUT",`/${parent}/f?x-s3sdk-write`,{"x-s3sdk-offset":"0"},"B");
		const list=h.deps.state.list;
		h.deps.state.list=async()=>{throw new Error("Fork must not scan annotation history");};
		for(const [source,target] of [[parent,child],[child,grandchild]]) expect((await call("PUT",`/${target}`,{"x-s3sdk-fork-source":source!})).status).toBe(200);
		h.deps.state.list=list;
		const history=await call("GET",`/${grandchild}/f?x-s3sdk-versions`);
		expect(await history.json()).toMatchObject({versions:[{operation:"put"},{operation:"write"}]});
	});
	it("creates with signed display and placement headers, resolves ids and preserves fork history", async () => {
		const h = await harness(), parent = bucketName(), child = bucketName();
		const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) => handle(await rawSigned(h, method, path, { headers, body }), h.deps);
		const created = await call("PUT", `/${parent}`, { "x-s3sdk-display-name": encodeURIComponent("Footage été"), "x-s3sdk-placement": "apac" });
		expect(created.status).toBe(200);
		const parentId = created.headers.get("x-s3sdk-drive-id");
		expect(parentId).toMatch(/^d-/);
		expect(created.headers.get("x-s3sdk-protocol")).toBe("1");
		const description = await call("GET", `/${parent}?x-s3sdk-drive`);
		expect(await description.json()).toMatchObject({ driveId: parentId, alias: parent, displayName: "Footage été", forkOf: null, forks: [] });
		const head = await call("HEAD", `/${parentId}`);
		expect(head.status).toBe(200);
		expect(head.headers.get("x-s3sdk-placement")).toBe("apac");
		const original = await call("PUT", `/${parent}/clip`, {}, "before");
		const originalVersion = original.headers.get("x-amz-version-id");
		const fork = await call("PUT", `/${child}`, { "x-s3sdk-fork-source": parent, "x-s3sdk-placement": "ignored-for-forks" });
		expect(fork.status).toBe(200);
		expect(fork.headers.get("x-s3sdk-fork-source-id")).toBe(parentId);
		expect(Date.parse(fork.headers.get("x-s3sdk-fork-point")!)).toBeGreaterThan(0);
		const childId = fork.headers.get("x-s3sdk-drive-id");
		expect(await (await call("GET", `/${child}?x-s3sdk-drive`)).json()).toMatchObject({ driveId: childId, forkOf: { driveId: parentId } });
		expect((await call("HEAD", `/${child}`)).headers.get("x-s3sdk-placement")).toBe("apac");
		expect(await (await call("GET", `/${child}/clip?x-s3sdk-versions`)).json()).toMatchObject({ versions: [{ versionId: originalVersion }] });
		await call("PUT", `/${parent}/clip`, {}, "parent");
		await call("PUT", `/${child}/clip`, {}, "child");
		expect(await (await call("GET", `/${parent}/clip`)).text()).toBe("parent");
		expect(await (await call("GET", `/${child}/clip`)).text()).toBe("child");
		const guarded = await call("DELETE", `/${parent}`, { "x-s3sdk-hard-delete": "true" });
		expect(guarded.status).toBe(409);
		expect(await guarded.text()).toContain("DriveHasForks");
		expect((await call("DELETE", `/${child}`, { "x-s3sdk-hard-delete": "true" })).status).toBe(204);
		expect((await call("DELETE", `/${parent}`, { "x-s3sdk-hard-delete": "true" })).status).toBe(204);
		expect((await call("HEAD", `/${parent}`)).status).toBe(404);
	});

	it("rejects malformed or tampered signed creation headers", async () => {
		const h = await harness();
		const invalid: Record<string, string>[] = [{ "x-s3sdk-placement": "mars" }, { "x-s3sdk-display-name": "%ZZ" }];
		for (const headers of invalid) {
			const response = await handle(await rawSigned(h, "PUT", `/${bucketName()}`, { headers }), h.deps);
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("InvalidArgument");
		}
		const request = await rawSigned(h, "PUT", `/${bucketName()}`, { headers: { "x-s3sdk-placement": "apac" } });
		request.headers.set("x-s3sdk-placement", "weur");
		expect((await handle(request, h.deps)).status).toBe(403);
	});

	it("refuses unsupported SpaceFS storage credentials while preserving native scoped mounts", async () => {
		const h = await harness(), bucket = bucketName();
		expect((await handle(await rawSigned(h, "PUT", `/${bucket}`), h.deps)).status).toBe(200);
		const unsupported = await handle(await rawSigned(h, "GET", `/${bucket}?x-s3sdk-mount`), h.deps);
		expect(unsupported.status).toBe(501);
		expect(await unsupported.text()).toContain("NotImplemented");
		const native = await handle(await rawSigned(h, "GET", `/${bucket}?x-uls-mount`), h.deps);
		expect(native.status).toBe(200);
		expect(await native.json()).toMatchObject({ canWrite: true, token: "scoped-token", endpoint: "https://data.test" });
	});
});
