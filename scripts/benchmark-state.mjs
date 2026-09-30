// Compare complete read->snapshot->JSON work, not only the isolated clone.
// node --expose-gc scripts/benchmark-state.mjs <baseline source directory>
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {performance} from "node:perf_hooks";
import {gzipSync,brotliCompressSync,constants} from "node:zlib";
import * as current from "../lib/relay/engine.mjs";
import {createMaintenanceScheduler} from "../standalone/maintenance.mjs";

assert.equal(typeof global.gc,"function","Use --expose-gc");
const baseline=await import(pathToFileURL(resolve(process.argv[2],"lib/relay/engine.mjs")));
const baselineMaintenance=await import(pathToFileURL(resolve(process.argv[2],"standalone/maintenance.mjs")));
const now=1700000000000,account="member-"+"a".repeat(32),other="member-"+"b".repeat(32);
const state=current.initialState(now),book=state.books.live;
book.accounts[account]=book.accounts[other]=0;
for(let i=0;i<20;i++)book.nodes.push({id:`node-${i}`,account:i%2?account:other,name:`GPU ${i}`,mode:"live",lastSeen:now,
 model:"fixture",context:8192,vram:8192,status:"online",capabilities:["chat"],tokenHash:"secret-"+i});
for(let i=0;i<1000;i++){
 const archived=i>=24,id=`job-${i}`,taskId=`task-${i}`;
 book.jobs.push({id,payer:i%2?account:other,kind:"chat",archived,spent:10,reserved:0,budget:10,
  status:"completed",finishedAt:now,documents:[],allowedNodes:[],
  ...(archived?{}:{messages:[{role:"user",content:("공개 자료 "+i+" ").repeat(1200)}]}),
  tasks:[{id:taskId,status:"settled",...(archived?{}:{output:("답변 "+i+" ").repeat(1200)})}]});
 book.ledger.push({type:"settlement",id:`ledger-${i}`,taskId,jobId:id,from:other,to:account,amount:10});
}
state.receipts=Array.from({length:512},(_,i)=>({id:`receipt-${i}`,result:{text:"r".repeat(600)}}));
const serialized=JSON.stringify(state),inputBytes=Buffer.byteLength(serialized);
assert.ok(inputBytes<1700000);
current.assertInvariants(state);
const options={owned:true};
const pipelines={
 admin:{baseline:()=>baseline.view(JSON.parse(serialized),now),current:()=>current.view(JSON.parse(serialized),now,options)},
 member:{baseline:()=>baseline.memberView(JSON.parse(serialized),account,now),current:()=>current.memberView(JSON.parse(serialized),account,now,options)},
};
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const report={node:process.version,inputBytes,scope:"Synthetic <1.7MB state; full parse, projection and JSON encoding; 9 alternating paired samples",results:{},compression:[]};
// Keep earlier cohorts alive: otherwise their collection corrupts later deltas.
globalThis.benchmarkSnapshots=[];
for(const [name,variants] of Object.entries(pipelines)){
 assert.deepEqual(variants.current(),variants.baseline());
 const samples={baseline:[],current:[]};
 for(let sample=0;sample<11;sample++)for(const variant of sample%2?["current","baseline"]:["baseline","current"]){
  global.gc();const start=performance.now();
  for(let i=0;i<5;i++)JSON.stringify(variants[variant]());
  if(sample>=2)samples[variant].push((performance.now()-start)/5);
 }
 report.results[name]=Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,{medianMs:median(values),samplesMs:values}]));
 // Snapshot retained by the caller; original row remains a string in the store.
 report.results[name].retainedHeap={};
 for(const variant of ["baseline","current"]){global.gc();const before=process.memoryUsage().heapUsed;const snapshots=Array.from({length:12},()=>variants[variant]());globalThis.benchmarkSnapshots.push(snapshots);global.gc();report.results[name].retainedHeap[variant]=(process.memoryUsage().heapUsed-before)/snapshots.length;assert.equal(snapshots.length,12);}
}
const payload=Buffer.from(JSON.stringify(pipelines.admin.current()));
report.idleMaintenance={checksPerSample:25,scope:"Synthetic unchanged revision; includes first parse, excludes SQLite I/O"};
const idleSamples={baseline:[],current:[]};
for(let sample=0;sample<11;sample++)for(const variant of sample%2?["current","baseline"]:["baseline","current"]){
 const make=variant==="baseline"?baselineMaintenance.createMaintenanceScheduler:createMaintenanceScheduler;
 const scheduler=make({store:{read:async()=>({revision:7,state:serialized})},listPoolIds:async()=>["synthetic"],clock:()=>now});
 global.gc();const start=performance.now();
 for(let i=0;i<25;i++)assert.deepEqual(await scheduler.runOnce(),{pools:1,ticks:0,errors:0});
 if(sample>=2)idleSamples[variant].push((performance.now()-start)/25);
 await scheduler.stop();
}
for(const [name,samplesMs] of Object.entries(idleSamples))report.idleMaintenance[name]={medianMs:median(samplesMs),samplesMs};
report.serialization={};
for(const name of ["parse","encode"]){
 const snapshot=pipelines.admin.current(),samples=[];
 for(let sample=0;sample<11;sample++){
  global.gc();const start=performance.now();
  for(let i=0;i<5;i++){
   const result=name==="parse"?JSON.parse(serialized):JSON.stringify(snapshot);
   assert.ok(result);
  }
  if(sample>=2)samples.push((performance.now()-start)/5);
 }
 report.serialization[name]={medianMs:median(samples),samplesMs:samples};
}
for(const options of [{level:1},{level:3},{level:6},{level:1,windowBits:13,memLevel:6},{level:3,windowBits:13,memLevel:6}]){
 const samples=[];let result;
 for(let i=0;i<11;i++){const start=performance.now();result=gzipSync(payload,options);if(i>=2)samples.push(performance.now()-start);}
 report.compression.push({encoding:"gzip",options,inputBytes:payload.length,outputBytes:result.length,medianMs:median(samples),samplesMs:samples});
}
for(const [quality,window] of [[1,22],[1,16],[3,16],[3,22],[4,22]]){
 const samples=[];let result;
 for(let i=0;i<11;i++){const start=performance.now();result=brotliCompressSync(payload,{params:{[constants.BROTLI_PARAM_QUALITY]:quality,[constants.BROTLI_PARAM_LGWIN]:window}});if(i>=2)samples.push(performance.now()-start);}
 report.compression.push({encoding:"br",quality,window,inputBytes:payload.length,outputBytes:result.length,medianMs:median(samples),samplesMs:samples});
}
report.sources={baseline:resolve(process.argv[2],"lib/relay/engine.mjs"),currentBytes:(await readFile(new URL("../lib/relay/engine.mjs",import.meta.url))).length};
console.log(JSON.stringify(report,null,2));
