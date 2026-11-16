import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { otpFromLog } from './helpers.mjs';
import { s3Signer } from './s3-sign.mjs';

/** Runs through real local Worker service bindings, D1, Durable Objects and R2 emulation. */
export async function parityChecks({root,api,s3,apiWorker,check,request,json,until,secrets}) {
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
    const sign=s3Signer(root);
    async function signed(method,operation,value) {
      const bytes=Buffer.from(JSON.stringify(value)),url=new URL(`/${drive}/direct?x-s3sdk-direct-${operation}`,s3);
      const headers=await sign(url,{method,key,body:bytes,headers:{'content-type':'application/json','content-length':String(bytes.length),'x-amz-content-sha256':createHash('sha256').update(bytes).digest('hex')}});
      return fetch(url,{method,headers,body:bytes,signal:AbortSignal.timeout(20000)});
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
  await check('parity 200 nested keys upload concurrently through real Workers',async()=>{
    assert(client,'requires parity setup');
    const bytes=randomBytes(4096),prefix='benchmark-fixtures/';
    for(let start=0;start<200;start+=8) {
      await Promise.all(Array.from({length:Math.min(8,200-start)},(_,i)=>client.putObject(drive,`${prefix}${start+i}`,bytes)));
    }
    assert.deepEqual((await client.listObjects(drive,{prefix})).keys.sort(),Array.from({length:200},(_,i)=>`${prefix}${i}`).sort());
  });
  await check('parity published SDK edits and rename preserve bytes through real Workers',async()=>{
    assert(client,'requires parity setup');
    await client.putObject(drive,'benchmark-edit/source','abcdef');
    await client.writeAt(drive,'benchmark-edit/source',1,'B');
    await client.patch(drive,'benchmark-edit/source',[{offset:2,data:Buffer.from('C')}]);
    await client.insert(drive,'benchmark-edit/source',3,'!');
    await client.removeRange(drive,'benchmark-edit/source',3,1);
    await client.truncate(drive,'benchmark-edit/source',5);
    await client.rename(drive,'benchmark-edit/source','benchmark-edit/destination');
    assert.equal(Buffer.from((await client.getObject(drive,'benchmark-edit/destination')).body).toString(),'aBCde');
    await assert.rejects(()=>client.getObject(drive,'benchmark-edit/source'),error=>error.status===404);
  });
  await check('parity eight concurrent 32 and 64 MiB reads match exact uploaded bytes',async()=>{
    assert(client,'requires parity setup');
    const source=randomBytes(64*1024*1024);
    for(const size of [32*1024*1024,64*1024*1024]) {
      const bytes=source.subarray(0,size),expected=createHash('sha256').update(bytes).digest('hex');
      await client.putObject(drive,'benchmark-large',bytes);
      await Promise.all(Array.from({length:8},async(_,reader)=>{
        const received=await client.getObject(drive,'benchmark-large');
        assert.equal(received.body.length,size,`reader ${reader}: received byte count for ${size}`);
        assert.equal(createHash('sha256').update(received.body).digest('hex'),expected,`reader ${reader}: SHA-256 for ${size}`);
      }));
    }
  });
  await check('parity frozen fork history with unchanged drive identity',async()=>{
    assert(client&&session,'requires parity setup');
    const original=await client.putObject(drive,'fork-proof','frozen');
    child=`parity-${Date.now().toString(36)}`;
    fork=await client.forkDrive(drive,child);
    await client.putObject(drive,'fork-proof','later parent');
    assert.equal(new TextDecoder().decode((await client.getObject(child,'fork-proof')).body),'frozen');
    assert.equal((await client.listVersions(child,'fork-proof'))[0].versionId,original.versionId);
    await client.deleteDrive(child,{hard:true});
  });
  client?.s3.destroy();
}
