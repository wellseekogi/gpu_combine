import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {appendFile,mkdir,mkdtemp,open,readdir,readFile,rm,stat,truncate} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import http from 'node:http';
import {createModelArtifacts} from '../standalone/model-artifacts.mjs';
import {bootAuditServer} from './audit-server-helper.mjs';

const work=resolve(import.meta.dirname,'../work');
const member=()=>({id:randomUUID(),token:randomUUID()+randomUUID(),name:'Model owner'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function gguf(size=256,version=3){
 const bytes=Buffer.alloc(size,0x61);
 bytes.write('GGUF');bytes.writeUInt32LE(version,4);
 bytes.writeBigUInt64LE(0n,8);bytes.writeBigUInt64LE(0n,16);
 return bytes;
}
function uploadRequest(bytes,{name='my-model.gguf',size=bytes.length,signal,body=bytes}={}){
 return new Request('http://localhost/api/member/models',{method:'POST',headers:{'content-length':String(size),'x-model-name':encodeURIComponent(name),'content-type':'application/octet-stream'},body,duplex:'half',signal});
}
async function files(directory){try{return await readdir(resolve(directory,'models'));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function cleanup(directory){assert.ok(directory.startsWith(work+sep));await rm(directory,{recursive:true,force:true});}
async function fixture(t,limits={}){
 await mkdir(work,{recursive:true});
 const dataDir=await mkdtemp(resolve(work,'artifacts-')),db=new DatabaseSync(':memory:');
 const live={nodes:[],jobs:[]},time={value:1700000000000};
 const store={read:async()=>({state:JSON.stringify({books:{live}})})};
 const artifacts=createModelArtifacts({db,dataDir,store,maxFileBytes:1024*1024,maxMemberBytes:4*1024*1024,maxTotalBytes:8*1024*1024,now:()=>time.value,...limits});
 t.after(async()=>{db.close();await cleanup(dataDir);});
 return {dataDir,db,store,artifacts,live,time};
}
async function upload(f,owner,bytes=gguf(),options={}){
 const response=await f.artifacts.upload(uploadRequest(bytes,options),owner);
 assert.equal(response.status,201);return (await response.json()).artifact;
}
function providerRequest(node,token=node.token){return new Request('http://localhost/api/provider/models/model',{headers:{'x-relay-node':node.id,authorization:'Bearer '+token}});}

test('raw model upload preserves bytes, derives SHA-256 and size, and keeps catalog/file ownership private',async t=>{
 const f=await fixture(t),alice=member(),bob=member(),bytes=gguf();
 const artifact=await upload(f,alice,bytes,{name:'내 모델.gguf'});
 assert.equal(artifact.name,'내 모델.gguf');assert.equal(artifact.size,bytes.length);assert.equal(artifact.digest,hash(bytes));
 assert.deepEqual(Object.keys(artifact).sort(),['digest','id','name','size']);
 assert.deepEqual(await readFile(resolve(f.dataDir,'models',artifact.id+'.gguf')),bytes);
 assert.deepEqual(f.artifacts.list(alice).artifacts,[artifact]);assert.deepEqual(f.artifacts.list(bob).artifacts,[]);
 assert.deepEqual(f.artifacts.getOwned(alice,artifact.id),artifact);
 assert.throws(()=>f.artifacts.getOwned(bob,artifact.id),error=>error.status===404);
 assert.throws(()=>f.artifacts.getOwned(alice,'../../secret'),error=>error.status===404);
 await assert.rejects(f.artifacts.remove(bob,artifact.id),error=>error.status===404);
 const removed=await f.artifacts.remove(alice,artifact.id);assert.deepEqual(await removed.json(),{removed:true});
 assert.deepEqual(f.artifacts.list(alice).artifacts,[]);assert.deepEqual(await files(f.dataDir),[]);
});

test('bad GGUF headers, size mismatches and unsafe file names leave no catalog or temporary files',async t=>{
 const f=await fixture(t,{maxFileBytes:512}),alice=member();
 const badMagic=gguf();badMagic.write('HTML');
 const cases=[
  [uploadRequest(badMagic),400],[uploadRequest(gguf(256,1)),400],
  [uploadRequest(gguf(),{name:'../model.gguf'}),400],[uploadRequest(gguf(),{name:'bad\u0000.gguf'}),400],
  [uploadRequest(gguf(),{name:'model.exe'}),400],[uploadRequest(gguf(1024)),413],
  [uploadRequest(gguf(256),{size:128}),413],[uploadRequest(gguf(24),{size:128}),400],
  [uploadRequest(gguf(),{size:0}),411],
 ];
 for(const [request,status] of cases){
  await assert.rejects(f.artifacts.upload(request,alice),error=>error.status===status);
  assert.deepEqual(f.artifacts.list(alice).artifacts,[]);assert.deepEqual(await files(f.dataDir),[]);
 }
 const artifact=await upload(f,alice,gguf(128,2));assert.equal(artifact.size,128,'GGUF v2 remains supported after failures');
});

test('interrupted and failed uploads release pending slots and remove bytes even after file rename',async t=>{
 const f=await fixture(t),alice=member();
 let controller;
 const body=new ReadableStream({start(value){controller=value;controller.enqueue(gguf(24));}});
 const aborter=new AbortController();
 const pending=f.artifacts.upload(uploadRequest(gguf(256),{body,signal:aborter.signal}),alice);
 // upload() reserves the member slot before its first await.
 await assert.rejects(f.artifacts.upload(uploadRequest(gguf()),alice),error=>error.status===409);
 aborter.abort();
 await assert.rejects(pending,error=>[400,408].includes(error.status));
 assert.deepEqual(await files(f.dataDir),[]);assert.deepEqual(f.artifacts.list(alice).artifacts,[]);
 assert.throws(()=>controller.enqueue(gguf(24)),'aborted reader is cancelled');
 f.db.exec("CREATE TRIGGER fail_artifact_insert BEFORE INSERT ON relay_model_artifacts BEGIN SELECT RAISE(ABORT,'injected insert failure'); END");
 await assert.rejects(f.artifacts.upload(uploadRequest(gguf()),alice),/injected insert failure/);
 assert.deepEqual(await files(f.dataDir),[]);assert.deepEqual(f.artifacts.list(alice).artifacts,[]);
 f.db.exec('DROP TRIGGER fail_artifact_insert');
 await upload(f,alice);assert.equal(f.artifacts.list(alice).artifacts.length,1);
});

test('storage quotas include committed and concurrent in-flight bytes',async t=>{
 const f=await fixture(t,{maxFileBytes:512,maxMemberBytes:512,maxTotalBytes:768}),alice=member(),bob=member(),carol=member();
 await upload(f,alice,gguf(400));
 await assert.rejects(f.artifacts.upload(uploadRequest(gguf(128)),alice),error=>error.status===413);
 let controller;
 const body=new ReadableStream({start(value){controller=value;controller.enqueue(gguf(24));}});
 const pending=f.artifacts.upload(uploadRequest(gguf(256),{body}),bob);
 await assert.rejects(f.artifacts.upload(uploadRequest(gguf(128)),carol),error=>error.status===413);
 controller.enqueue(gguf(256).subarray(24));controller.close();
 await pending;
 assert.equal(f.artifacts.list(bob).artifacts[0].size,256);
});

test('batched model upload preserves fragmented headers, partial writes, and flushes before catalog publication',async t=>{
 const f=await fixture(t),alice=member(),bytes=gguf(512*1024);
 const probe=await open(resolve(f.dataDir,'probe'),'w'),prototype=Object.getPrototypeOf(probe);await probe.close();
 const write=prototype.write,writev=prototype.writev,sync=prototype.sync;
 let vectors=0,flushes=0,offset=0;
 t.mock.method(prototype,'write',function(buffer,start,length,position){return write.call(this,buffer,start,Math.min(length,1024),position);});
 t.mock.method(prototype,'writev',async function(buffers,position){vectors++;const result=await writev.call(this,buffers.slice(0,1),position);return {...result,buffers};});
 t.mock.method(prototype,'sync',function(){flushes++;assert.deepEqual(f.artifacts.list(alice).artifacts,[],'catalog must remain empty until the file is flushed');return sync.call(this);});
 const body=new ReadableStream({pull(controller){
  if(offset===bytes.length){controller.close();return;}
  const end=Math.min(bytes.length,offset+(offset<24?1:4096));controller.enqueue(bytes.subarray(offset,end));offset=end;
 }});
 const artifact=await upload(f,alice,bytes,{body});
 assert.ok(vectors>0,'multiple chunks use native vector writes');assert.equal(flushes,1);
 assert.equal(artifact.digest,hash(bytes));assert.deepEqual(await readFile(resolve(f.dataDir,'models',artifact.id+'.gguf')),bytes);
});

test('disk failures unblock a pending body read and never publish an unflushed artifact',{timeout:10000},async t=>{
 const f=await fixture(t),alice=member();
 const probe=await open(resolve(f.dataDir,'probe'),'w'),prototype=Object.getPrototypeOf(probe);await probe.close();
 let cancelled=false;
 const body=new ReadableStream({start(controller){controller.enqueue(gguf(24));},cancel(){cancelled=true;}});
 const failedWrite=t.mock.method(prototype,'write',async()=>{throw Error('injected disk write failure');});
 await assert.rejects(f.artifacts.upload(uploadRequest(gguf(256),{body}),alice),/injected disk write failure/);
 assert.ok(cancelled);assert.deepEqual(f.artifacts.list(alice).artifacts,[]);assert.deepEqual(await files(f.dataDir),[]);
 failedWrite.mock.restore();
 const failedFlush=t.mock.method(prototype,'sync',async()=>{throw Error('injected disk flush failure');});
 await assert.rejects(f.artifacts.upload(uploadRequest(gguf()),alice),/injected disk flush failure/);
 assert.deepEqual(f.artifacts.list(alice).artifacts,[]);assert.deepEqual(await files(f.dataDir),[]);
 failedFlush.mock.restore();
 await upload(f,alice);assert.equal(f.artifacts.list(alice).artifacts.length,1,'failed uploads release the pending slot');
});

test('provider model download requires an authenticated current lease for exactly that artifact',async t=>{
 const f=await fixture(t),alice=member(),bytes=gguf(100000),artifact=await upload(f,alice,bytes);
 const otherArtifact=await upload(f,alice,gguf(64));
 const node={id:randomUUID(),token:randomUUID()+randomUUID(),status:'online'};
 node.tokenHash=hash(node.token);f.live.nodes.push(node);
 const second={id:randomUUID(),token:randomUUID()+randomUUID(),status:'online'};
 second.tokenHash=hash(second.token);f.live.nodes.push(second);
 await assert.rejects(f.artifacts.download(providerRequest(node),artifact.id),error=>error.status===403);
 const task={status:'leased',lease:{nodeId:node.id,expiresAt:f.time.value+30000}};
 const job={modelArtifact:artifact,deadline:f.time.value+3600000,tasks:[task]};f.live.jobs.push(job);
 await assert.rejects(f.artifacts.remove(alice,artifact.id),error=>error.status===409);
 await assert.rejects(f.artifacts.download(providerRequest(second),artifact.id),error=>error.status===403);
 await assert.rejects(f.artifacts.download(providerRequest(node,'wrong'),artifact.id),error=>error.status===401);
 await assert.rejects(f.artifacts.download(providerRequest(node),otherArtifact.id),error=>error.status===403);
 const response=await f.artifacts.download(providerRequest(node),artifact.id);
 assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal(response.headers.get('x-model-sha256'),artifact.digest);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 for(const mutate of [
  ()=>{task.lease.expiresAt=f.time.value;},
  ()=>{task.lease.expiresAt=f.time.value+30000;job.cancelled=true;},
  ()=>{job.cancelled=false;node.status='paused';},
  ()=>{node.status='online';job.archived=true;},
  ()=>{job.archived=false;job.deadline=f.time.value;},
 ]){mutate();await assert.rejects(f.artifacts.download(providerRequest(node),artifact.id),error=>error.status===403);}
 job.deadline=f.time.value+3600000;node.revoked=true;
 await assert.rejects(f.artifacts.download(providerRequest(node),artifact.id),error=>error.status===401);
 node.revoked=false;task.status='ready';
 await assert.rejects(f.artifacts.remove(alice,artifact.id),error=>error.status===409,'queued rental keeps artifact reserved');
 task.status='cancelled';await f.artifacts.remove(alice,artifact.id);
});

test('rental preparation can download only its reserved model until the session ends',async t=>{
 const f=await fixture(t),alice=member(),artifact=await upload(f,alice,gguf(128));
 const node={id:randomUUID(),token:randomUUID()+randomUUID(),status:'online',lastSeen:f.time.value};
 node.tokenHash=hash(node.token);f.live.nodes.push(node);
 const job={kind:'rental',modelArtifact:artifact,allowedNodes:[node.id],deadline:Number.MAX_SAFE_INTEGER,tasks:[]};
 f.live.jobs.push(job);
 assert.deepEqual(Buffer.from(await (await f.artifacts.download(providerRequest(node),artifact.id)).arrayBuffer()),gguf(128));
 await assert.rejects(f.artifacts.remove(alice,artifact.id),error=>error.status===409);
 node.lastSeen=f.time.value-45000;
 await assert.rejects(f.artifacts.download(providerRequest(node),artifact.id),error=>error.status===403);
 node.lastSeen=f.time.value;job.finishedAt=f.time.value;job.cancelled=true;
 await assert.rejects(f.artifacts.download(providerRequest(node),artifact.id),error=>error.status===403);
 await f.artifacts.remove(alice,artifact.id);
});

test('model download bounds growth, rejects truncation, and closes after cancellation or read failure',async t=>{
 const f=await fixture(t),alice=member(),bytes=gguf(700000),artifact=await upload(f,alice,bytes);
 const path=resolve(f.dataDir,'models',artifact.id+'.gguf');
 const node={id:randomUUID(),token:randomUUID()+randomUUID(),status:'online'};node.tokenHash=hash(node.token);f.live.nodes.push(node);
 f.live.jobs.push({modelArtifact:artifact,deadline:f.time.value+3600000,tasks:[{status:'leased',lease:{nodeId:node.id,expiresAt:f.time.value+30000}}]});
 const probe=await open(path,'r'),prototype=Object.getPrototypeOf(probe);await probe.close();
 const originalOpen=fs.open;let closed=0;
 const opened=t.mock.method(fs,'open',async(...args)=>{const handle=await originalOpen(...args);handle.once('close',()=>{closed++;});return handle;});
 syncBuiltinESMExports();t.after(()=>{opened.mock.restore();syncBuiltinESMExports();});
 const response=await f.artifacts.download(providerRequest(node),artifact.id);
 await appendFile(path,Buffer.alloc(100000,0x62));
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes,'growth cannot exceed the advertised size');
 assert.equal(closed,1);
 const shortened=await f.artifacts.download(providerRequest(node),artifact.id);
 await truncate(path,bytes.length-1);
 await assert.rejects(shortened.arrayBuffer(),/declared size/);assert.equal(closed,2);
 const cancelled=await f.artifacts.download(providerRequest(node),artifact.id);
 await cancelled.body.cancel();assert.equal(closed,3,'an unread response closes immediately on cancellation');
 const failedRead=t.mock.method(prototype,'read',async()=>{throw Error('injected file read failure');});
 const failed=await f.artifacts.download(providerRequest(node),artifact.id);
 await assert.rejects(failed.arrayBuffer(),/injected file read failure/);assert.equal(closed,4);
 failedRead.mock.restore();
});

test('model download contains close failure on idle revocation and safely aborts an in-flight read',{timeout:10000},async t=>{
 const f=await fixture(t),alice=member(),artifact=await upload(f,alice,gguf(700000));
 const node={id:randomUUID(),token:randomUUID()+randomUUID(),status:'online'};node.tokenHash=hash(node.token);f.live.nodes.push(node);
 f.live.jobs.push({modelArtifact:artifact,deadline:f.time.value+3600000,tasks:[{status:'leased',lease:{nodeId:node.id,expiresAt:f.time.value+30000}}]});
 const probe=await open(resolve(f.dataDir,'models',artifact.id+'.gguf'),'r'),prototype=Object.getPrototypeOf(probe);await probe.close();
 const originalOpen=fs.open,read=prototype.read;let closed=0,failClose=true;
 const opened=t.mock.method(fs,'open',async(...args)=>{
  const handle=await originalOpen(...args),close=handle.close;
  handle.once('close',()=>{closed++;});
  handle.close=async()=>{await close();if(failClose){failClose=false;throw Error('injected close failure');}};
  return handle;
 });
 syncBuiltinESMExports();t.after(()=>{opened.mock.restore();syncBuiltinESMExports();});
 const idleReads=t.mock.method(prototype,'read',read);
 const idle=await f.artifacts.download(providerRequest(node),artifact.id);node.status='paused';
 await new Promise(resolve=>setTimeout(resolve,1150));
 await assert.rejects(idle.arrayBuffer(),/grant ended/);assert.equal(closed,1,'revocation closes even without body consumption');
 assert.equal(idleReads.mock.callCount(),0,'an idle Web response retains no model-byte read-ahead');
 node.status='online';
 let release,entered;
 const reading=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 t.mock.method(prototype,'read',async function(...args){const result=await read.apply(this,args);entered();await gate;return result;});
 const aborter=new AbortController(),request=new Request(providerRequest(node),{signal:aborter.signal});
 const response=await f.artifacts.download(request,artifact.id),reader=response.body.getReader();
 const pending=reader.read(),rejected=assert.rejects(pending,/aborted/);
 await reading;aborter.abort();await rejected;assert.equal(closed,2);
 release();await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(reader.read(),/aborted/,'completed disk reads cannot enqueue bytes after abort');
});

test('artifact deletion and job acquisition are fenced in both race orders and locks recover after failure',async t=>{
 const f=await fixture(t),alice=member(),artifact=await upload(f,alice);
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const acquisition=f.artifacts.withOwned(alice,artifact.id,async selected=>{assert.equal(selected.id,artifact.id);await gate;});
 await assert.rejects(f.artifacts.remove(alice,artifact.id),error=>error.status===409);
 release();await acquisition;
 await assert.rejects(f.artifacts.withOwned(alice,artifact.id,async()=>{throw Error('rejected command');}),/rejected command/);
 const originalRead=f.store.read;
 let continueRead;
 f.store.read=()=>new Promise(resolve=>{continueRead=()=>resolve({state:JSON.stringify({books:{live:f.live}})});});
 const deletion=f.artifacts.remove(alice,artifact.id);
 await assert.rejects(f.artifacts.withOwned(alice,artifact.id,async()=>{}),error=>error.status===409);
 continueRead();await deletion;f.store.read=originalRead;
 assert.deepEqual(f.artifacts.list(alice).artifacts,[]);assert.deepEqual(await files(f.dataDir),[]);
});

const auth=user=>({'x-relay-member':user.id,authorization:'Bearer '+user.token});
test('HTTP upload, own-model rental, fenced provider download, cancellation and deletion use real routes',async t=>{
 const server=await bootAuditServer();t.after(async()=>{await server.close();await cleanup(server.dataDir);});
 const alice=member(),bob=member();
 const json=async(path,body,user,extra={})=>{
  const response=await fetch(server.origin+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(user?auth(user):{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
 };
 for(const user of [alice,bob])assert.equal((await json('/api/member/register',user)).status,200);
 const bytes=gguf(128000);
 const unauthorized=await fetch(server.origin+'/api/member/models',{method:'POST',headers:{'x-model-name':'model.gguf'},body:bytes});
 assert.equal(unauthorized.status,401);await unauthorized.body.cancel();
 const uploaded=await fetch(server.origin+'/api/member/models',{method:'POST',headers:{...auth(alice),'content-type':'application/octet-stream','x-model-name':encodeURIComponent('my upload.gguf')},body:bytes});
 assert.equal(uploaded.status,201,'raw upload exceeds normal 90 KB JSON request limit');
 const {artifact}=await uploaded.json();assert.equal(artifact.digest,hash(bytes));assert.equal(artifact.size,bytes.length);
 assert.deepEqual((await json('/api/member/models',undefined,bob)).body.artifacts,[]);
 const base={digest:'a'.repeat(64),runtime:'b'.repeat(64),template:'c'.repeat(64),context:8192};
 const token=randomUUID()+randomUUID();
 const registered=await json('/api/member/devices',{requestId:randomUUID(),token,name:'Peer rental GPU',modelName:'Provider bootstrap',model:base,vram:8192},bob);
 assert.equal(registered.status,200);const node=registered.body.config.node;
 const provider=async(action,payload={})=>json('/api/provider',{poolId:'local-owner',nodeId:node,action,payload},null,{authorization:'Bearer '+token});
 const poll={modelDigest:base.digest,runtime:base.runtime,template:base.template,capabilities:['chat','renter-model']};
 await provider('poll',poll);
 const download=()=>fetch(server.origin+'/api/provider/models/'+artifact.id,{headers:{authorization:'Bearer '+token,'x-relay-node':node}});
 assert.equal((await download()).status,403,'connected GPU cannot download before assignment');
 const request={action:'chat',requestId:randomUUID(),payload:{artifactId:artifact.id,allowedNodes:[node],context:4096,maxTokens:128,messages:[{role:'user',content:'PRIVATE RENTAL PROMPT 492804'}],publicData:true}};
 assert.equal((await json('/api/member/command',request,bob)).status,404,'another member cannot select Alice model');
 const rental=await json('/api/member/command',request,alice);assert.equal(rental.status,200);
 const jobId=rental.body.result.jobId;
 assert.ok(!JSON.stringify((await json('/api/member/offers')).body).includes('PRIVATE RENTAL PROMPT'));
 assert.ok(!JSON.stringify((await json('/api/member/me',undefined,bob)).body).includes('PRIVATE RENTAL PROMPT'));
 const attemptedDelete=await fetch(server.origin+'/api/member/models/'+artifact.id,{method:'DELETE',headers:auth(alice)});
 assert.equal(attemptedDelete.status,409);
 const task=(await provider('poll',poll)).body.result.task;assert.equal(task.modelArtifact.id,artifact.id);assert.equal(task.model.digest,artifact.digest);
 const downloaded=await download();assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
 const cancelled=await json('/api/member/command',{action:'cancel',requestId:randomUUID(),payload:{jobId}},alice);assert.equal(cancelled.status,200);
 assert.equal(cancelled.body.state.books.live.reserved,0);assert.equal(cancelled.body.state.books.live.accounts['member-'+alice.id],100);
 assert.equal((await download()).status,403,'cancelled lease cannot retrieve the model');
 assert.equal((await fetch(server.origin+'/api/member/models/'+artifact.id,{method:'DELETE',headers:auth(bob)})).status,404);
 const removed=await fetch(server.origin+'/api/member/models/'+artifact.id,{method:'DELETE',headers:auth(alice)});
 assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{removed:true});
 assert.deepEqual((await json('/api/member/models',undefined,alice)).body.artifacts,[]);
 assert.deepEqual(await files(server.dataDir),[]);
});

test('HTTP disconnected upload cleans partial disk data and permits retry with the same member',async t=>{
 const server=await bootAuditServer();t.after(async()=>{await server.close();await cleanup(server.dataDir);});
 const alice=member();
 const registered=await fetch(server.origin+'/api/member/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(alice)});assert.equal(registered.status,200);await registered.body.cancel();
 let request;
 const opened=new Promise(resolve=>{
  request=http.request(server.origin+'/api/member/models',{method:'POST',headers:{...auth(alice),'x-model-name':'interrupted.gguf','content-length':'1000000'}},response=>response.resume());
  request.on('error',()=>{});request.write(gguf(4096),resolve);
 });
 await opened;
 const end=Date.now()+5000;
 while(!(await files(server.dataDir)).some(name=>name.endsWith('.part'))&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok((await files(server.dataDir)).some(name=>name.endsWith('.part')),'upload created a partial file before disconnect');
 request.destroy();
 while((await files(server.dataDir)).length&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(await files(server.dataDir),[]);
 const retry=await fetch(server.origin+'/api/member/models',{method:'POST',headers:{...auth(alice),'x-model-name':'retry.gguf'},body:gguf(256)});
 assert.equal(retry.status,201);const {artifact}=await retry.json();
 assert.equal((await stat(resolve(server.dataDir,'models',artifact.id+'.gguf'))).size,256);
});
