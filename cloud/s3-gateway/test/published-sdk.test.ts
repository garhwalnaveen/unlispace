import { S3SDKClient } from "@spacefs/s3sdk";
import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import { handle } from "../src/index";
import { bucketName, harness, KEY_ID, requestHandler, secretOf } from "./helpers";

it("runs the published SpaceFS TypeScript SDK against Orbit", async () => {
  const h = await harness();
  const sdk = new S3SDKClient({
    endpoint:"https://s3.test", accessKeyId:KEY_ID, secretAccessKey:await secretOf(KEY_ID),
    s3:{requestHandler:requestHandler(h.deps),maxAttempts:1},
    fetch: ((input:RequestInfo | URL, init?:RequestInit) => {
      const headers = new Headers(init?.headers);
      // A real HTTP fetch supplies this signed header for byte-array request bodies.
      if (init?.body instanceof Uint8Array) headers.set("content-length",String(init.body.byteLength));
      return handle(new Request(input,{...init,headers}),h.deps);
    }) as typeof fetch,
  });
  const drive = bucketName(), fork = bucketName();
  const created = await sdk.createDrive(drive,{displayName:"SDK footage",placement:"apac"});
  expect(created.driveId).toMatch(/^d-/);
  expect(await sdk.describeDrive(drive)).toMatchObject({driveId:created.driveId,displayName:"SDK footage"});
  expect((await sdk.listDrives()).map(d=>d.name)).toContain(drive);
  const first = await sdk.putObject(drive,"old/été.txt","abcdef",{contentType:"text/plain"});
  expect(new TextDecoder().decode((await sdk.getObject(drive,"old/été.txt",{consistent:true})).body)).toBe("abcdef");
  expect(new TextDecoder().decode(await sdk.readRange(drive,"old/été.txt",{offset:1,length:3}))).toBe("bcd");
  await sdk.writeAt(drive,"old/été.txt",0,"A",{ifVersion:first.versionId});
  await expect(sdk.writeAt(drive,"old/été.txt",0,"X",{ifVersion:first.versionId})).rejects.toMatchObject({status:412,code:"PreconditionFailed"});
  await sdk.patch(drive,"old/été.txt",[{offset:1,data:new TextEncoder().encode("B")}]);
  await sdk.insert(drive,"old/été.txt",2,"!");
  await sdk.removeRange(drive,"old/été.txt",2,1);
  await sdk.truncate(drive,"old/été.txt",4);
  await sdk.rename(drive,"old/été.txt","new/été.txt");
  expect((await sdk.listObjects(drive,{prefix:"new/",consistent:true})).keys).toEqual(["new/été.txt"]);
  const history = await sdk.listVersions(drive,"new/été.txt",{consistent:true});
  expect(history[0]!.versionId).toBe(first.versionId);
  expect(new TextDecoder().decode((await sdk.getObject(drive,"new/été.txt",{asOf:history[0]!.lastModifiedRaw})).body)).toBe("abcdef");
  expect((await sdk.restoreVersion(drive,"new/été.txt",first.versionId)).restoredFrom).toBe(first.versionId);
  const branched = await sdk.forkDrive(drive,fork);
  expect(branched.sourceDriveId).toBe(created.driveId);
  await sdk.putObject(fork,"new/été.txt","isolated");
  expect(new TextDecoder().decode((await sdk.getObject(drive,"new/été.txt")).body)).toBe("abcdef");
  await sdk.deleteObject(fork,"new/été.txt");
  const versions = await sdk.s3.send(new ListObjectVersionsCommand({Bucket:fork}));
  expect(versions.Versions ?? []).toEqual([]);
  expect(versions.DeleteMarkers ?? []).toEqual([]);
  await sdk.deleteDrive(fork,{hard:true});
  await sdk.deleteDrive(drive,{hard:true});
  await expect(sdk.describeDrive(drive)).rejects.toMatchObject({status:404,code:"NoSuchBucket"});
});
