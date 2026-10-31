import { afterEach, expect, it } from "vitest";
import { api, commit, newDrive, putFile } from "./helpers";
import { genKey, installJwks, setAllowDev, signToken } from "./auth-helpers";
const search = async (d: string, q: string, cursor?: string, token?: string) => {
  const params = new URLSearchParams({q,limit:"1"});
  if (cursor) params.set("cursor",cursor);
  const response = await api(`/v0/drives/${d}/search?${params}`, token ? {token} : {});
  expect(response.status).toBe(200);
  return response.json<{entries:{path:string}[];cursor:string|null}>();
};
afterEach(() => setAllowDev("1"));
it("indexes filename substrings with pagination, Unicode and literal query syntax", async () => {
  const d = await newDrive();
  await putFile(d,"docs/Quarterly report.txt","one");
  await putFile(d,"docs/report-final.txt","two");
  await putFile(d,'literal "OR" 100%.txt',"three");
  await putFile(d,"資料/日本語資料.txt","four");
  const a = await search(d,"REPORT");
  expect(a.entries.map(e=>e.path)).toEqual(["docs/Quarterly report.txt"]);
  expect(a.cursor).toBeTruthy();
  const b = await search(d,"report",a.cursor!);
  expect(b.entries.map(e=>e.path)).toEqual(["docs/report-final.txt"]);
  expect(b.cursor).toBeNull();
  expect((await search(d,'"OR"')).entries.map(e=>e.path)).toEqual(['literal "OR" 100%.txt']);
  expect((await search(d,"100%")).entries).toHaveLength(1);
  expect((await search(d,"日本語")).entries.map(e=>e.path)).toEqual(["資料/日本語資料.txt"]);
});
it("returns current renamed paths and excludes detached descendants", async () => {
  const d = await newDrive();
  await putFile(d,"old/needle.txt","one");
  await commit(d,[{op:"rename",from:"old/",to:"new/"}]);
  expect((await search(d,"needle")).entries.map(e=>e.path)).toEqual(["new/needle.txt"]);
  await commit(d,[{op:"rename",from:"new/needle.txt",to:"new/changed.txt"}]);
  expect((await search(d,"needle")).entries).toEqual([]);
  expect((await search(d,"changed")).entries).toHaveLength(1);
  await commit(d,[{op:"delete",path:"new/"}]);
  expect((await search(d,"changed")).entries).toEqual([]);
});
it("requires drive read authorization and validates bounds", async () => {
  const d = await newDrive(), other = await newDrive();
  await putFile(d,"private-report.txt","secret");
  const key=await genKey("search-key"); installJwks(key);
  const read=await signToken(key,{drives:[{id:d,access:"read"}]});
  expect((await search(d,"report",undefined,read)).entries).toHaveLength(1);
  expect((await api(`/v0/drives/${other}/search?q=report`,{token:read})).status).toBe(404);
  expect((await api(`/v0/drives/${d}/search?q=report`,{token:null})).status).toBe(401);
  for (const params of ["q=ab","q=report&limit=-1","q=report&cursor=../bad","q=report&cursor=-1","q=report&cursor=1.5","q=report&cursor=9007199254740992","q=report&cursor=1e2","q=report&cursor="]) {
    expect((await api(`/v0/drives/${d}/search?${params}`)).status).toBe(400);
  }
});

it("bounds common-match ancestor work and advances cursors past detached candidates", async () => {
  const d = await newDrive();
  const empty = (path: string) => ({op:"put",path,size:0,contentType:"text/plain",mtimeMs:1,shards:[]});
  expect((await commit(d,Array.from({length:101},(_,i)=>empty(`old/deep/tree/common-${i}.txt`)))).status).toBe(200);
  expect((await commit(d,[{op:"delete",path:"old/"},empty("visible/common-a.txt"),empty("visible/common-b.txt")])).status).toBe(200);
  const first = await api(`/v0/drives/${d}/search?q=common&limit=3`);
  expect(first.status).toBe(200);
  const a=await first.json<{entries:{path:string}[];cursor:string|null}>();
  expect(a.entries).toEqual([]);
  expect(a.cursor).toMatch(/^[0-9]+$/);
  const next=await api(`/v0/drives/${d}/search?${new URLSearchParams({q:"common",limit:"100",cursor:a.cursor!})}`);
  expect(next.status).toBe(200);
  const b=await next.json<{entries:{path:string}[];cursor:string|null}>();
  expect(b.entries.map(e=>e.path)).toEqual(["visible/common-a.txt","visible/common-b.txt"]);
  expect(b.cursor).toBeNull();
});
