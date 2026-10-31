export const INLINE_MANIFEST_BYTES = 256 * 1024;
export const MAX_STREAM_COMMIT_BYTES = 8 * 1024 * 1024;
const enc = new TextEncoder();
export const MANIFEST_PAGE_SHARDS = 1000;
export const MAX_TREE_PAGES = 1000;
interface PageReference {h: string; size: number; count: number}
interface IndexReference {h: string; size: number; pages: number}
export type ManifestTree = {format: "uls-manifest-v1"; size: number; pages: PageReference[]}
  | {format: "uls-manifest-v2"; size: number; indexes: IndexReference[]};
const hashPattern = /^[a-f0-9]{64}$/;
export function manifestTree(value: unknown): ManifestTree {
  const tree = value as ManifestTree;
  if (!tree || !["uls-manifest-v1","uls-manifest-v2"].includes(tree.format) || !Number.isSafeInteger(tree.size) || tree.size < 0 || tree.size > 5 * 1024 ** 4) throw new Error("invalid manifest tree");
  const references = tree.format === "uls-manifest-v1" ? tree.pages : tree.indexes;
  if (!Array.isArray(references) || references.length > MAX_TREE_PAGES) throw new Error("invalid manifest index");
  let size = 0;
  for (const page of references) {
    const count = tree.format === "uls-manifest-v1" ? (page as PageReference).count : (page as IndexReference).pages;
    if (!page || !hashPattern.test(page.h) || !Number.isSafeInteger(page.size) || page.size < 1 || !Number.isInteger(count) || count < 1 || count > MANIFEST_PAGE_SHARDS) throw new Error("invalid manifest page reference");
    size += page.size;
  }
  if (size !== tree.size) throw new Error("manifest tree size mismatch");
  return tree;
}

async function manifestIndex(bucket: Pick<R2Bucket,"get">,lineage:string,reference:IndexReference): Promise<Extract<ManifestTree,{format:"uls-manifest-v1"}>> {
  const tree=manifestTree(await loadMetadata(bucket,lineage,`r2:${reference.h}`));
  if (tree.format !== "uls-manifest-v1" || tree.size !== reference.size || tree.pages.length !== reference.pages) throw new Error("manifest index size mismatch");
  return tree;
}

async function leafPage(bucket:Pick<R2Bucket,"get">,lineage:string,page:PageReference):Promise<[string,number][]> {
  const shards=manifestShards(await loadMetadata(bucket,lineage,`r2:${page.h}`));
  if(shards.length!==page.count || shards.reduce((n,s)=>n+s[1],0)!==page.size)throw new Error("manifest page size mismatch");
  return shards;
}
export function manifestShards(value: unknown): [string, number][] {
  if (!Array.isArray(value) || value.length > MANIFEST_PAGE_SHARDS) throw new Error("invalid manifest page");
  for (const shard of value) if (!Array.isArray(shard) || shard.length !== 2 || typeof shard[0] !== "string" || !hashPattern.test(shard[0]) || !Number.isSafeInteger(shard[1]) || shard[1] < 1 || shard[1] > 16 * 1024 * 1024) throw new Error("invalid manifest shard");
  return value as [string, number][];
}

export async function storeMetadata(bucket: Pick<R2Bucket, "put">, lineage: string, value: unknown): Promise<string> {
  const data = enc.encode(JSON.stringify(value));
  if (data.length > INLINE_MANIFEST_BYTES) throw new Error("metadata page exceeds size limit");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(b => b.toString(16).padStart(2, "0")).join("");
  await bucket.put(`manifests/${lineage}/${hash}`, data, {sha256: hash, onlyIf: {etagDoesNotMatch: "*"}});
  return hash;
}

/** Each yielded page bounds metadata memory independently of total object size. */
export async function* iterateManifest(bucket: Pick<R2Bucket, "get">, lineage: string, ref: string): AsyncGenerator<{shards: [string, number][]; metadata: string[]}> {
  if (!ref.startsWith("tree:")) {
    yield {shards: await loadMetadata(bucket, lineage, ref) as [string, number][], metadata: ref.startsWith("r2:") ? [ref.slice(3)] : []};
    return;
  }
  const root = manifestTree(await loadMetadata(bucket, lineage, `r2:${ref.slice(5)}`));
  let first=true;
  if (root.format === "uls-manifest-v1") {
    for (const page of root.pages) {
      yield {shards:await leafPage(bucket,lineage,page),metadata:first ? [ref.slice(5),page.h] : [page.h]};first=false;
    }
  } else {
    for (const index of root.indexes) {
      const tree=await manifestIndex(bucket,lineage,index);
      for(let i=0;i<tree.pages.length;i++) {
        const page=tree.pages[i]!;
        yield {shards:await leafPage(bucket,lineage,page),metadata:[...(first?[ref.slice(5)]:[]),...(i===0?[index.h]:[]),page.h]};first=false;
      }
    }
  }
  if(first)yield{shards:[],metadata:[ref.slice(5)]};
}

export async function readManifestPage(bucket: Pick<R2Bucket, "get">, lineage: string, ref: string, index: number): Promise<{shards: [string, number][]; next: number | null}> {
  if (!ref.startsWith("tree:")) {
    const refs = await loadMetadata(bucket, lineage, ref) as [string, number][];
    return {shards: refs.slice(index * MANIFEST_PAGE_SHARDS, (index + 1) * MANIFEST_PAGE_SHARDS), next: (index + 1) * MANIFEST_PAGE_SHARDS < refs.length ? index + 1 : null};
  }
  const root = manifestTree(await loadMetadata(bucket, lineage, `r2:${ref.slice(5)}`));
  let pages:PageReference[],local=index,total:number;
  if(root.format === "uls-manifest-v1") {pages=root.pages;total=pages.length;}
  else {
    total=root.indexes.reduce((n,item)=>n+item.pages,0);
    const reference=root.indexes.find(item=>{if(local<item.pages)return true;local-=item.pages;return false;});
    if(!reference){if(index===0&&root.size===0)return{shards:[],next:null};throw new Error("invalid manifest cursor");}
    pages=(await manifestIndex(bucket,lineage,reference)).pages;
  }
  const page = pages[local];
  if (!page) { if (index === 0 && root.size === 0) return {shards: [], next: null}; throw new Error("invalid manifest cursor"); }
  return {shards:await leafPage(bucket,lineage,page), next: index + 1 < total ? index + 1 : null};
}

export async function storeManifest(bucket: R2Bucket, lineage: string, manifest: string): Promise<string> {
	const data = enc.encode(manifest);
	if (data.byteLength <= INLINE_MANIFEST_BYTES) return manifest;
	const digest = await crypto.subtle.digest("SHA-256", data);
	const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	await bucket.put(`manifests/${lineage}/${hash}`, data, { sha256: hash, onlyIf: { etagDoesNotMatch: "*" } });
	return "r2:" + hash;
}

export async function loadMetadata(bucket: Pick<R2Bucket, "get">, lineage: string, ref: string): Promise<unknown> {
	if (!ref.startsWith("r2:")) return JSON.parse(ref);
	const object = await bucket.get(`manifests/${lineage}/${ref.slice(3)}`);
	if (!object) throw new Error("retained manifest missing");
	if (object.size > MAX_STREAM_COMMIT_BYTES) throw new Error("manifest exceeds size limit");
	const data = await object.arrayBuffer();
	const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
	if (hash !== ref.slice(3)) throw new Error("manifest checksum mismatch");
	return JSON.parse(new TextDecoder().decode(data));
}

export async function loadManifest(bucket: Pick<R2Bucket, "get">, lineage: string, ref: string): Promise<[string, number][]> {
    const shards: [string, number][] = [];
    for await (const page of iterateManifest(bucket, lineage, ref)) shards.push(...page.shards);
    return shards;
}
export async function loadXattrs(bucket: Pick<R2Bucket, "get">, lineage: string, ref: string | null): Promise<import("./types").Xattrs> {
    return ref ? await loadMetadata(bucket, lineage, ref) as import("./types").Xattrs : {};
}
