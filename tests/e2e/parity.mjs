import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { otpFromLog } from './helpers.mjs';

/** Runs through real local Worker service bindings, D1, Durable Objects and R2 emulation. */
export async function parityChecks({root,api,s3,apiWorker,check,request,json,until,secrets}) {
  const require=createRequire(join(root,'cloud/s3-gateway/package.json'));
  const {S3SDKClient}=await import(pathToFileURL(join(root,'cloud/s3-gateway/node_modules/@spacefs/s3sdk/dist/index.js')));
  let session,org,drive,key,client,fork,child;
  const body=Buffer.from('parity direct bytes');
  const hash=createHash('sha256').update(body).digest('hex');
  await check('parity setup session and published SDK through real Workers',async()=>{
    const email=`parity+${Date.now()}@example.com`,offset=apiWorker.stdout.length;
    await json(api,'/auth/otp/start',{body:{email}});
    let code;
    await until(()=>{code=otpFromLog(apiWorker.stdout.slice(offset),email);return !!code;},5000,'parity OTP missing');
    secrets.push(code);
    session=await json(api,'/auth/otp/verify',{body:{email,code}});
    secrets.push(session.accessToken,session.refreshToken);
    const organizations=(await json(api,'/orgs',{token:session.accessToken})).orgs;
    org=organizations[0].id;drive=organizations[0].drives[0].id;
    const minted=await request(api,'/keys',{token:session.accessToken,body:{workspaceId:org,access:'admin',label:'local parity'}});
    assert.equal(minted.status,201);key=minted.data;
    secrets.push(key.secretAccessKey);
    client=new S3SDKClient({endpoint:s3,accessKeyId:key.accessKeyId,secretAccessKey:key.secretAccessKey,s3:{maxAttempts:1}});
    const put=await client.putObject(drive,'proof','published SDK proof');
    assert(put.versionId);
    assert.equal(new TextDecoder().decode((await client.getObject(drive,'proof')).body),'published SDK proof');
  });
  await check('parity direct upload capability and verified commit across real services',async()=>{
    assert(client,'requires parity setup');
    const {SignatureV4}=require('@smithy/signature-v4');
    const {Sha256}=require('@aws-crypto/sha256-js');
    const signer=new SignatureV4({service:'s3',region:'auto',sha256:Sha256,credentials:key,uriEscapePath:false});
    async function signed(method,operation,value) {
      const bytes=Buffer.from(JSON.stringify(value)),url=new URL(`/${drive}/direct?x-s3sdk-direct-${operation}`,s3);
      const signed=await signer.sign({protocol:url.protocol,hostname:url.hostname,port:Number(url.port),method,path:url.pathname,query:Object.fromEntries(url.searchParams),headers:{host:url.host,'content-type':'application/json','content-length':String(bytes.length),'x-amz-content-sha256':createHash('sha256').update(bytes).digest('hex')},body:bytes});
      return fetch(url,{method,headers:signed.headers,body:bytes,signal:AbortSignal.timeout(20000)});
    }
    const shards=[{hash,length:body.length}];
    const response=await signed('POST','plan',{shards});
    assert.equal(response.status,200,await response.clone().text());
    const plan=await response.json();assert.equal(plan.upload.length,1);
    const upload=await fetch(plan.upload[0].url,{method:'PUT',body,signal:AbortSignal.timeout(20000)});
    assert.equal(upload.status,201,await upload.text());
    const committed=await signed('PUT','commit',{shards,token:plan.token,size:body.length,contentHash:hash});
    assert.equal(committed.status,200,await committed.text());
    assert(Buffer.from((await client.getObject(drive,'direct')).body).equals(body));
  });
  await check('parity frozen fork history and recovery with unchanged drive identity',async()=>{
    assert(client&&session,'requires parity setup');
    const original=await client.putObject(drive,'fork-proof','frozen');
    child=`parity-${Date.now().toString(36)}`;
    fork=await client.forkDrive(drive,child);
    await client.putObject(drive,'fork-proof','later parent');
    assert.equal(new TextDecoder().decode((await client.getObject(child,'fork-proof')).body),'frozen');
    assert.equal((await client.listVersions(child,'fork-proof'))[0].versionId,original.versionId);
    await client.deleteDrive(child);
    const deleted=await json(api,`/orgs/${org}/deleted-drives`,{token:session.accessToken});
    assert(deleted.drives.some(d=>d.id===fork.driveId));
    const restored=await request(api,`/drives/${fork.driveId}/restore`,{token:session.accessToken,body:{}});
    assert.equal(restored.status,200);assert.equal(restored.data.id,fork.driveId);
    assert.equal(new TextDecoder().decode((await client.getObject(child,'fork-proof')).body),'frozen');
    await client.deleteDrive(child,{hard:true});
  });
  client?.s3.destroy();
}
