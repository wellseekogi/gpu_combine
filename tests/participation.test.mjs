import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {fork} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {randomBytes,randomUUID} from "node:crypto";
import {createParticipation} from "../standalone/participation.mjs";
import {execute,errorResponse} from "../lib/relay/service.mjs";
import {RelayError,hash,fixture as engineFixture} from "../lib/relay/engine.mjs";
const root=resolve(import.meta.dirname,"..");
const contract={digest:"a".repeat(64),runtime:"b".repeat(64),template:"c".repeat(64),context:8192};
const member=()=>({id:randomUUID(),token:randomUUID()+randomUUID(),name:"개인 회원"});
const device=()=>({requestId:randomUUID(),token:randomUUID()+randomUUID(),name:"내 PC",modelName:"내 GGUF",model:contract,vram:8192});
const memberHeaders=value=>({"x-relay-member":value.id,authorization:"Bearer "+value.token});
function fixture(signupCredits=100,now=()=>Date.now()){
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE relay_pools(id TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL)");
 const store={read:async id=>db.prepare("SELECT revision,state FROM relay_pools WHERE id=?").get(id),insert:async(id,state)=>db.prepare("INSERT OR IGNORE INTO relay_pools(id,revision,state) VALUES (?,0,?)").run(id,state),compareAndSwap:async(id,revision,state)=>db.prepare("UPDATE relay_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?").run(state,id,revision).changes===1};
 const identity=request=>{if(request.headers.get("x-test-admin")!=="yes")throw new RelayError("로그인이 필요합니다.",401);};
 const handler=createParticipation({db,store,root,identity,limit:()=>{},coordinator:()=>"https://relay.example.org",signupCredits,now});
 const call=async(path,body,{user,admin=false}={})=>{
  const request=new Request("https://relay.example.org"+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json",...(user?memberHeaders(user):{}),...(admin?{"x-test-admin":"yes"}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  let response;try{response=await handler(request,"127.0.0.1");}catch(error){response=errorResponse(error);}
  assert.ok(response,"The API route must be handled");
  return {status:response.status,body:await response.json()};
 };
 const command=(user,action,payload={},requestId=randomUUID())=>call("/api/member/command",{action,payload,requestId},{user});
 return {db,store,call,command};
}

test("member registration is atomic, idempotent, hash-only, private and grants configured signup credits exactly once",async()=>{
 const {db,store,call}=fixture();
 try{
  const person=member();
  assert.equal((await call("/api/member/me")).status,401);
  assert.equal((await call("/api/member/me",undefined,{admin:true})).status,401,"operator session is not member identity");
  assert.equal((await call("/api/participation/request",{})).status,410,"legacy manual approval is removed");
  db.exec("CREATE TRIGGER fail_member_insert BEFORE INSERT ON relay_members BEGIN SELECT RAISE(ABORT,'injected member commit failure'); END");
  assert.equal((await call("/api/member/register",person)).status,503);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM relay_members").get().count,0);
  assert.equal(Object.keys(JSON.parse((await store.read("local-owner")).state).books.live.accounts).length,2);
  db.exec("DROP TRIGGER fail_member_insert");
  const results=await Promise.all([call("/api/member/register",{...person,initialCredit:9999,signupCredits:9999}),call("/api/member/register",person)]);
  assert.ok(results.every(result=>result.status===200));
  assert.deepEqual(results[0].body,{id:person.id,name:person.name,account:"member-"+person.id});
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM relay_members").get().count,1);
  assert.equal((await call("/api/member/register",{...person,name:"changed"})).status,409);
  assert.equal((await call("/api/member/register",{...person,token:member().token})).status,401);
  const me=await call("/api/member/me",undefined,{user:person});
  assert.deepEqual(me.body.credits,{balance:100,available:100,reserved:0});
  assert.deepEqual(Object.keys(me.body.state.books),["live"]);
  assert.deepEqual(Object.keys(me.body.state.books.live.accounts),["member-"+person.id]);
  assert.equal((await call("/api/member/me",undefined,{user:{...person,token:member().token}})).status,401);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM relay_members").all()).includes(person.token),false);
  const state=JSON.parse((await store.read("local-owner")).state);
  assert.equal(state.books.live.issued,1100);
  assert.equal(state.books.live.ledger.filter(entry=>entry.reason==="signup").length,1);
  assert.equal((await call("/api/participation/info")).body.signupCredits,100);
  assert.equal(state.books.live.accounts.requester,1000);
  for(let index=0;index<255;index++)db.prepare("INSERT INTO relay_members(id,tokenHash,name,account,createdAt) VALUES (?,?,?,?,0)").run(randomUUID(),"bounded-"+index,"test","member-bounded-"+index);
  assert.equal((await call("/api/member/register",member())).status,429);
 }finally{db.close();}
});

test("signup policy is server-configured and client input cannot select or repeat its grant",async()=>{
 for(const credits of [0,37,1000]){
  const {db,call}=fixture(credits);
  try{
   const person={...member(),initialCredit:9999,signupCredits:9999,credits:9999};
   assert.equal((await call("/api/participation/info")).body.signupCredits,credits);
   assert.equal((await call("/api/member/register",person)).status,200);
   assert.equal((await call("/api/member/register",person)).status,200);
   assert.equal((await call("/api/member/me",undefined,{user:person})).body.credits.balance,credits);
  }finally{db.close();}
 }
 for(const credits of [-1,1001,1.5,NaN])assert.throws(()=>createParticipation({signupCredits:credits}),/RELAY_SIGNUP_CREDITS/);
});

test("direct member PC registration is atomic and owned, with no operator approval or GPU heartbeat",async()=>{
 const {db,store,call,command}=fixture();
 try{
  const alice=member(),bob=member(),pc=device();
  await call("/api/member/register",alice);await call("/api/member/register",bob);
  assert.equal((await call("/api/member/devices",pc)).status,401);
  assert.equal((await call("/api/member/devices",{...pc,token:alice.token},{user:alice})).status,400);
  assert.equal((await call("/api/member/devices",{...pc,model:{...contract,context:0}},{user:alice})).status,400);
  db.exec("CREATE TRIGGER fail_device_insert BEFORE INSERT ON relay_member_devices BEGIN SELECT RAISE(ABORT,'injected device commit failure'); END");
  assert.equal((await call("/api/member/devices",pc,{user:alice})).status,503);
  let live=JSON.parse((await store.read("local-owner")).state).books.live;
  assert.equal(live.models.length,0);assert.equal(live.nodes.length,0);
  db.exec("DROP TRIGGER fail_device_insert");
  const pair=await Promise.all([call("/api/member/devices",{...pc,ownerAccount:"member-"+bob.id,account:"member-"+bob.id,tokenHash:"f".repeat(64)},{user:alice}),call("/api/member/devices",pc,{user:alice})]);
  assert.ok(pair.every(response=>response.status===200));
  assert.deepEqual(pair[0].body,pair[1].body);
  const config=pair[0].body.config;
  assert.equal(Object.hasOwn(config,"token"),false);assert.deepEqual(config.model,contract);
  live=JSON.parse((await store.read("local-owner")).state).books.live;
  assert.equal(live.models.length,1);assert.equal(live.nodes.length,1);
  assert.equal(live.nodes[0].account,"member-"+alice.id);assert.equal(live.nodes[0].lastSeen,0);
  assert.equal(live.nodes[0].tokenHash,await hash(pc.token));
  assert.equal((await call("/api/member/devices",{...pc,name:"changed"},{user:alice})).status,409);
  assert.equal((await call("/api/member/devices",{...pc,requestId:randomUUID()},{user:bob})).status,409);
  const before=await store.read("local-owner");
  assert.equal((await call("/api/participation/verify",{node:config.node,token:pc.token})).body.status,"offline");
  assert.deepEqual(await store.read("local-owner"),before);
  assert.deepEqual((await call("/api/member/offers")).body,{offers:[]});
  assert.equal((await command(bob,"pause",{nodeId:config.node})).status,404);
  assert.equal((await command(alice,"pause",{nodeId:config.node})).status,200);
  assert.equal((await command(alice,"resume",{nodeId:config.node})).status,200);
  assert.equal(JSON.parse((await store.read("local-owner")).state).books.live.nodes[0].lastSeen,0);
  const bobPc={...device(),vram:4096};assert.equal((await call("/api/member/devices",bobPc,{user:bob})).status,200);
  live=JSON.parse((await store.read("local-owner")).state).books.live;
  assert.equal(live.models.length,1);
  assert.equal(live.models[0].minVram,0,"GPU capacity must not become a shared model minimum");
  const pinned={...contract,digest:"d".repeat(64)};
  await execute(store,"local-owner",{mode:"live",action:"model",payload:{...pinned,name:"Existing operator constraint",minVram:8192},requestId:randomUUID()});
  assert.equal((await call("/api/member/devices",{...device(),model:pinned,vram:4096},{user:bob})).status,409);
  assert.equal((await call("/api/participation/verify",{node:config.node,token:bobPc.token})).status,401);
  assert.equal((await command(alice,"revoke",{nodeId:config.node})).status,200);
  assert.equal((await call("/api/participation/verify",{node:config.node,token:pc.token})).status,401);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM relay_member_devices").all()).includes(pc.token),false);
 }finally{db.close();}
});

test("fileless pairing registers one GPU under the code owner and returns its private connection config",async()=>{
 const {db,store,call}=fixture();
 try{
  const alice=member(),bob=member();
  await call("/api/member/register",alice);await call("/api/member/register",bob);
  assert.equal((await call("/api/member/pairings",{})).status,401);
  const created=await call("/api/member/pairings",{},{user:alice});
  assert.match(created.body.code,/^[A-Za-z0-9_-]{22}$/);
  assert.ok(created.body.expiresAt>Date.now());
  const statusPath="/api/member/pairings/"+created.body.code;
  assert.deepEqual((await call(statusPath,undefined,{user:alice})).body,{status:"pending"});
  assert.equal((await call(statusPath,undefined,{user:bob})).status,404);
  const pc={...device(),model:{digest:"0".repeat(64),runtime:contract.runtime,template:"0".repeat(64),context:8192}};
  const payload={...pc,code:created.body.code};
  const results=await Promise.all([call("/api/participation/pair",payload),call("/api/participation/pair",payload)]);
  assert.ok(results.some(result=>result.status===200));
  assert.ok(results.every(result=>[200,409].includes(result.status)));
  const config=results.find(result=>result.status===200).body.config;
  for(const result of results.filter(result=>result.status===200))assert.deepEqual(result.body,{config});
  assert.equal(config.token,pc.token);
  assert.equal(config.coordinator,"https://relay.example.org");
  assert.equal(config.model.digest,"0".repeat(64));
  assert.deepEqual((await call(statusPath,undefined,{user:alice})).body,{status:"paired",nodeId:config.node});
  assert.deepEqual((await call("/api/participation/pair",payload)).body,{config},"lost responses can be replayed");
  assert.equal((await call("/api/participation/pair",{...payload,token:device().token})).status,409);
  assert.equal((await call("/api/participation/pair",{...payload,name:"Other PC"})).status,409);
  assert.equal((await call("/api/participation/pair",{...payload,requestId:randomUUID()})).status,409);
  assert.equal((await call("/api/participation/verify",{node:config.node,token:pc.token})).status,200);
  const live=JSON.parse((await store.read("local-owner")).state).books.live;
  assert.equal(live.nodes.length,1);
  assert.equal(live.nodes[0].account,"member-"+alice.id);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM relay_member_devices").all()).includes(pc.token),false);
 }finally{db.close();}
});

test("pairing codes expire, cap pending sessions, and allow correction before retry limit",async()=>{
 let time=Date.now();
 const {db,call}=fixture(100,()=>time);
 try{
  const owner=member();await call("/api/member/register",owner);
  const codes=[];
  for(let i=0;i<3;i++)codes.push((await call("/api/member/pairings",{},{user:owner})).body.code);
  assert.equal((await call("/api/member/pairings",{},{user:owner})).status,429);
  const bad={...device(),code:codes[0],model:{...contract,context:0}};
  assert.equal((await call("/api/participation/pair",bad)).status,400);
  const corrected=await call("/api/participation/pair",{...bad,model:contract});
  assert.equal(corrected.status,200);
  const racing=(await call("/api/member/pairings",{},{user:owner})).body.code;
  const claims=await Promise.all([call("/api/participation/pair",{...device(),code:racing}),call("/api/participation/pair",{...device(),code:racing})]);
  assert.deepEqual(claims.map(result=>result.status).sort(),[200,409],"one code cannot register two different PCs concurrently");
  for(let i=0;i<5;i++)assert.equal((await call("/api/participation/pair",{...bad,code:codes[1]})).status,400);
  assert.equal((await call("/api/participation/pair",{...bad,code:codes[1]})).status,404);
  time+=600001;
  assert.equal((await call("/api/member/pairings/"+codes[2],undefined,{user:owner})).status,404);
  assert.equal((await call("/api/participation/pair",{...bad,code:codes[2],model:contract})).status,404);
  assert.equal((await call("/api/member/pairings",{},{user:owner})).status,200);
 }finally{db.close();}
});

test("concurrent member and device registration cannot commit the same credential in both roles",async()=>{
 for(const reverse of [false,true]){
  const {db,store,call}=fixture();
  try{
   const owner=member(),joining=member(),pc={...device(),token:joining.token};
   await call("/api/member/register",owner);
   const read=store.read;
   let remaining=2,release;
   const barrier=new Promise(resolve=>{release=resolve;});
   // Both operations pass their public prechecks against the same pool revision.
   store.read=async id=>{const row=await read(id);if(remaining>0){remaining--;if(remaining===0)release();await barrier;}return row;};
   const calls=[()=>call("/api/member/register",joining),()=>call("/api/member/devices",pc,{user:owner})];
   if(reverse)calls.reverse();
   const responses=await Promise.all(calls.map(invoke=>invoke()));
   assert.equal(responses.filter(response=>response.status===200).length,1);
   assert.equal(responses.filter(response=>response.status===400).length,1);
   assert.equal(db.prepare("SELECT COUNT(*) AS count FROM relay_members m JOIN relay_member_devices d ON m.tokenHash=d.tokenHash").get().count,0);
   const before=await store.read("local-owner");
   const replay=await Promise.all(calls.map(invoke=>invoke()));
   assert.deepEqual(replay.map(response=>response.status),responses.map(response=>response.status));
   assert.deepEqual(await store.read("local-owner"),before,"replays cannot create another account, grant or node");
  }finally{db.close();}
 }
});

test("a legacy provider node key cannot become a member identity credential",async()=>{
 const {db,store,call}=fixture();
 try{
  const joining=member();
  const model=await execute(store,"local-owner",{mode:"live",action:"model",payload:{...contract,name:"Legacy model",minVram:0},requestId:randomUUID()});
  const node=await execute(store,"local-owner",{mode:"live",action:"node",payload:{name:"Legacy PC",vram:4096,modelId:model.result.modelId,token:joining.token},requestId:randomUUID()});
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM relay_member_devices").get().count,0);
  const before=await store.read("local-owner");
  assert.equal((await call("/api/member/register",joining)).status,400);
  assert.equal((await call("/api/member/register",joining)).status,400);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM relay_members").get().count,0);
  assert.deepEqual(await store.read("local-owner"),before);
  assert.equal((await call("/api/participation/verify",{node:node.result.nodeId,token:joining.token})).status,200);
 }finally{db.close();}
});

test("members spend only their balance on other members' GPUs and earnings stay private and conserved",async()=>{
 const {db,store,call,command}=fixture();
 try{
  const alice=member(),bob=member();
  const aliceAccount=(await call("/api/member/register",alice)).body.account,bobAccount=(await call("/api/member/register",bob)).body.account;
  const pc=device(),config=(await call("/api/member/devices",pc,{user:bob})).body.config;
  const modelId=(await call("/api/member/me",undefined,{user:alice})).body.state.books.live.models[0].id;
  const allocation={account:aliceAccount,amount:200,requestId:randomUUID()};
  assert.equal((await call("/api/member/allocate",allocation,{user:alice})).status,401);
  assert.equal((await call("/api/member/members",undefined,{user:alice})).status,401);
  for(const action of ["allocate","member-account","model","node"])assert.equal((await command(alice,action,{account:aliceAccount,amount:200})).status,403);
  assert.equal((await call("/api/member/allocate",allocation,{admin:true})).status,200);
  const source={title:"공개 테스트 문서",url:"",text:"라이선스: MIT"};
  const payload={title:"회원 작업",payer:bobAccount,modelId,publicData:true,fields:["라이선스"],documents:[source],budget:10,minutes:30,allowedNodes:[config.node]};
  const created=await command(alice,"create",payload);
  assert.equal(created.status,200);
  assert.equal(created.body.state.books.live.jobs[0].payer,aliceAccount);
  const memberList=(await call("/api/member/members",undefined,{admin:true})).body.members;
  assert.equal(memberList.find(value=>value.account===aliceAccount).available,290);
  assert.equal((await command(bob,"cancel",{jobId:created.body.result.jobId})).status,404);
  assert.equal((await call("/api/member/me",undefined,{user:bob})).body.state.books.live.jobs.length,0);
  const proof={modelDigest:contract.digest,runtime:contract.runtime,template:contract.template};
  const poll=await execute(store,"local-owner",{mode:"live",action:"poll",nodeId:config.node,token:pc.token,payload:proof},{provider:true});
  const task=poll.result.task;assert.ok(task);
  await execute(store,"local-owner",{mode:"live",action:"submit",nodeId:config.node,token:pc.token,payload:{...proof,taskId:task.taskId,attemptId:task.lease.attemptId,epoch:task.lease.epoch,raw:engineFixture(source,["라이선스"]),finishReason:"stop"}},{provider:true});
  const aliceView=(await call("/api/member/me",undefined,{user:alice})).body,bobView=(await call("/api/member/me",undefined,{user:bob})).body;
  assert.equal(aliceView.credits.balance,290);assert.equal(bobView.credits.balance,109);
  assert.equal(JSON.stringify(aliceView).includes(bobAccount),false);assert.equal(JSON.stringify(bobView).includes(aliceAccount),false);
  assert.equal(Object.hasOwn(bobView.state.books.live.ledger.at(-1),"jobId"),false);
  const second=device();assert.equal((await call("/api/member/devices",second,{user:bob})).status,200);
  assert.equal((await call("/api/member/me",undefined,{user:bob})).body.credits.balance,109,"new PC must not reset member earnings");
  const live=JSON.parse((await store.read("local-owner")).state).books.live;
  assert.equal(live.accounts.requester,800);assert.equal(live.accounts.operator,1);
  assert.equal(Object.values(live.accounts).reduce((sum,value)=>sum+value,0),live.issued);
  assert.equal(JSON.stringify(live).includes(pc.token),false);
 }finally{db.close();}
});

async function boot(directory,admin){
 const child=fork(resolve(root,"standalone/server.mjs"),[],{cwd:root,env:{...process.env,RELAY_DATA_DIR:directory,RELAY_ADMIN_TOKEN:admin,RELAY_HOST:"127.0.0.1",RELAY_PORT:"0",RELAY_PUBLIC_ORIGIN:"",RELAY_SECURE_COOKIE:"0",RELAY_LAUNCH_LOGIN:"0",RELAY_SIGNUP_CREDITS:"100"},stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});
 let output="",origin;
 await new Promise((accept,reject)=>{
  const timeout=setTimeout(()=>{child.kill();reject(new Error("Server startup failed: "+output));},10000);
  child.stdout.on("data",data=>{output+=data;origin=output.match(/Relay ready at (\S+)/)?.[1]??origin;});
  child.stderr.on("data",data=>{output+=data;});
  child.once("error",error=>{clearTimeout(timeout);reject(error);});
  child.once("exit",code=>{clearTimeout(timeout);reject(new Error("Server exited: "+code+" "+output));});
  child.on("message",message=>{if(message==="relay:ready"){clearTimeout(timeout);accept();}});
 });
 return {origin,close:()=>new Promise(accept=>{if(child.exitCode!==null){accept();return;}const timeout=setTimeout(()=>child.kill(),5000);child.once("exit",()=>{clearTimeout(timeout);accept();});child.send("relay:shutdown");})};
}

test("HTTP member identity and direct PC registration persist without operator login or secret storage",async()=>{
 const directory=await mkdtemp(resolve(root,"work/member-qa-")),admin=randomBytes(32).toString("hex");
 let server;
 const request=async(path,body,user,headers={})=>{
  const response=await fetch(server.origin+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json",...(user?memberHeaders(user):{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {response,body:response.headers.get("content-type")?.includes("json")?await response.json():new Uint8Array(await response.arrayBuffer())};
 };
 try{
  server=await boot(directory,admin);
  const person=member(),pc=device();
  assert.equal((await request("/api/relay")).response.status,401);
  assert.equal((await request("/api/member/register",person,undefined,{origin:"https://untrusted.example"})).response.status,403);
  assert.equal((await request("/api/member/register",person)).response.status,200);
  const config=(await request("/api/member/devices",pc,person)).body.config;
  assert.equal(config.coordinator,server.origin);
  const view=(await request("/api/member/me",undefined,person)).body;
  assert.equal(view.credits.balance,100);assert.equal(view.state.books.live.nodes[0].connected,false);
  assert.equal((await request("/api/member/me",undefined,{...person,token:pc.token})).response.status,401);
  assert.equal((await request("/api/participation/verify",{node:config.node,token:person.token})).response.status,401);
  const zip=await request("/api/participation/provider.zip");assert.equal(zip.response.status,200);assert.equal(zip.body[0],80);assert.equal(zip.body[1],75);
  await server.close();server=await boot(directory,admin);
  const restoredMember=(await request("/api/member/me",undefined,person)).body;
  assert.equal(restoredMember.id,person.id);
  assert.equal(restoredMember.credits.balance,100);
  assert.equal(restoredMember.state.books.live.ledger.filter(entry=>entry.reason==="signup").length,1);
  const restored=(await request("/api/member/devices",pc,person)).body.config;
  assert.equal(restored.node,config.node);
  assert.equal((await request("/api/member/me",undefined,person)).body.state.books.live.nodes.length,1);
  assert.equal((await request("/api/member/command",{action:"revoke",payload:{nodeId:config.node},requestId:randomUUID()},person)).response.status,200);
  assert.equal((await request("/api/participation/verify",{node:config.node,token:pc.token})).response.status,401);
  for(let count=0;count<12;count++)assert.equal((await request("/api/member/register",person)).response.status,200);
  assert.equal((await request("/api/member/register",person)).response.status,429);
  assert.equal((await request("/api/member/me",undefined,person)).body.credits.balance,100);
  await server.close();server=null;
  const bytes=await readFile(resolve(directory,"relay.sqlite"));
  assert.equal(bytes.includes(Buffer.from(person.token)),false);assert.equal(bytes.includes(Buffer.from(pc.token)),false);
 }finally{await server?.close();await rm(directory,{recursive:true,force:true});}
});
