import {spawn} from "node:child_process";import{randomBytes}from"node:crypto";import assert from"node:assert/strict";import{fixture}from"../lib/relay/engine.mjs";
const token=randomBytes(32).toString("hex"),base="http://127.0.0.1:8792";let cookie="",proc,log="";
const env={...process.env,RELAY_ADMIN_TOKEN:token,RELAY_PORT:"8792",RELAY_DATA_DIR:"work/http-qa-"+Date.now()};
async function boot(){proc=spawn(process.execPath,["standalone/server.mjs"],{env,stdio:"pipe",windowsHide:true});proc.stderr.on("data",d=>log+=d);for(let i=0;i<100;i++){try{if((await fetch(base)).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error("Server startup failed "+log)}
async function stop(){const ended=new Promise(r=>proc.once("exit",r));proc.kill();await ended;}
async function req(path,data,headers={}){const r=await fetch(base+path,{method:data?"POST":"GET",headers:{...headers,"Content-Type":"application/json",Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});return{r,body:await r.json()};}
async function login(){const r=await req("/api/login",{token});cookie=r.r.headers.get("set-cookie").split(";")[0];}
const action=(a,p,requestId=crypto.randomUUID())=>req("/api/relay",{mode:"live",action:a,payload:p,requestId});
let checks=0;
try{
 await boot();
 assert.equal((await req("/api/relay")).r.status,401);checks++;
 assert.equal((await req("/api/relay",null,{"oai-authenticated-user-id":"spoof"})).r.status,401);checks++;
 await login();
 assert.equal((await req("/api/relay")).r.status,200);checks++;
 assert.equal((await req("/api/relay",{mode:"demo",action:"tick",requestId:crypto.randomUUID()},{Origin:"https://evil.example"})).r.status,403);checks++;
 const model={name:"Synthetic API test, no GPU",digest:"a".repeat(64),runtime:"b".repeat(64),template:"c".repeat(64),context:8192,minVram:0};
 const m=(await action("model",model)).body.result;const key=crypto.randomUUID()+crypto.randomUUID();
 const n=(await action("node",{name:"Synthetic protocol test",modelId:m.modelId,vram:0,token:key})).body.result;
 const doc={title:"Synthetic public fixture",url:"",text:"라이선스: MIT"};
 const command={title:"Protocol integration (no inference)",modelId:m.modelId,publicData:true,fields:["라이선스"],documents:[doc],budget:20,minutes:30};
 const job=(await action("create",command)).body.result;
 const worker=(a,p={},override={})=>req("/api/provider",{poolId:"local-owner",nodeId:n.nodeId,action:a,payload:p,...override},{Authorization:"Bearer "+key});
 assert.equal((await worker("status")).body.result.paused,false);checks++;
 assert.equal((await worker("poll",{modelDigest:"wrong",runtime:model.runtime,template:model.template})).r.status,409);checks++;
 const p={modelDigest:model.digest,runtime:model.runtime,template:model.template};const task=(await worker("poll",p)).body.result.task;
 assert.ok(task.document.text.includes("MIT"));checks++;
 const payload={...p,taskId:task.taskId,attemptId:task.lease.attemptId,epoch:task.lease.epoch,raw:fixture(doc,["라이선스"]),finishReason:"stop"};
 const [a,b]=await Promise.all([worker("submit",payload),worker("submit",payload)]);
 assert.equal(a.body.result.receipt,b.body.result.receipt);checks++;
 const state=(await req("/api/relay")).body.state;
 assert.equal(state.books.live.jobs[0].spent,10);assert.equal(state.books.live.ledger.filter(l=>l.type==="settlement").length,1);checks++;
 assert.ok(!JSON.stringify(state).includes(key));assert.ok(!JSON.stringify(state).includes("tokenHash"));checks++;
 await action("archive",{jobId:job.jobId});assert.equal((await worker("submit",payload)).body.result.receipt,a.body.result.receipt);checks++;
 await stop();await boot();await login();
 const restored=(await req("/api/relay")).body.state;assert.equal(restored.books.live.jobs[0].spent,10);checks++;
 await action("revoke",{nodeId:n.nodeId});assert.equal((await worker("status")).r.status,401);checks++;
 console.log(JSON.stringify({pass:true,checks,scope:"HTTP authentication, authorization, source checks, provider protocol, atomic settlement, idempotency, restart durability; synthetic responses only"}));
}catch(e){console.error(e);console.error(log);process.exitCode=1;}finally{if(proc?.exitCode===null)await stop();}

