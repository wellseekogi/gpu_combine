// Synthetic bounded artifact upload/download; actual hashes and fsync, no WAN/GPU claim.
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{module:{type:'string'},output:{type:'string'},mib:{type:'string',default:'64'},repeats:{type:'string',default:'5'},chunk:{type:'string',default:'65536'},mode:{type:'string',default:'both'}}});
const root=resolve(import.meta.dirname,'..'),work=resolve(root,'work');
const size=Number(values.mib)*1024**2,repeats=Number(values.repeats),chunkSize=Number(values.chunk);
if(!Number.isSafeInteger(size)||size<24||size>1024**3||!Number.isSafeInteger(repeats)||repeats<1||repeats>30||!Number.isSafeInteger(chunkSize)||chunkSize<24||chunkSize>1024**2||!['both','upload','download'].includes(values.mode))throw Error('Invalid benchmark arguments');
const source=resolve(values.module??resolve(root,'standalone/model-artifacts.mjs'));
const {createModelArtifacts}=await import(pathToFileURL(source));
await mkdir(work,{recursive:true});
const dataDir=await mkdtemp(resolve(work,'artifact-benchmark-'));
if(!dataDir.startsWith(work+sep))throw Error('Unsafe benchmark cleanup');
const db=new DatabaseSync(':memory:');
const block=Buffer.alloc(chunkSize,0x61);block.write('GGUF');block.writeUInt32LE(3,4);block.writeBigUInt64LE(0n,8);block.writeBigUInt64LE(0n,16);
const expected=createHash('sha256');for(let offset=0;offset<size;offset+=chunkSize)expected.update(block.subarray(0,Math.min(chunkSize,size-offset)));
const digest=expected.digest('hex'),member={id:'benchmark-member'},node={id:'benchmark-node',tokenHash:createHash('sha256').update('synthetic-token').digest('hex'),status:'online'};
const live={nodes:[node],jobs:[]},store={read:async()=>({state:JSON.stringify({books:{live}})})};
const artifacts=createModelArtifacts({db,dataDir,store,maxFileBytes:size,maxMemberBytes:size*2,maxTotalBytes:size*2});
const report={scope:'Synthetic file transfer through actual artifact functions, fresh streamed chunks; SHA-256 and upload fsync retained; no HTTP/TLS/WAN/GPU. Memory peaks include uncollected buffers, not only live queues.',source,size,chunkSize,repeats,results:{upload:[],download:[]}};
const measure=async operation=>{
 global.gc?.();const before=process.memoryUsage();let peakExternal=before.external,peakArrayBuffers=before.arrayBuffers;
 const sample=()=>{const memory=process.memoryUsage();peakExternal=Math.max(peakExternal,memory.external);peakArrayBuffers=Math.max(peakArrayBuffers,memory.arrayBuffers);};
 const timer=setInterval(sample,1),start=performance.now();
 try{await operation();sample();return {elapsedMs:performance.now()-start,peakExternalIncrease:peakExternal-before.external,peakArrayBuffersIncrease:peakArrayBuffers-before.arrayBuffers};}
 finally{clearInterval(timer);}
};
const upload=async()=>{
 let offset=0;
 const body=new ReadableStream({pull(controller){if(offset===size){controller.close();return;}const chunk=Buffer.from(block.subarray(0,Math.min(chunkSize,size-offset)));offset+=chunk.length;controller.enqueue(chunk);}});
 const request=new Request('http://localhost/api/member/models',{method:'POST',headers:{'content-length':String(size),'x-model-name':'synthetic.gguf'},body,duplex:'half'});
 const result=await artifacts.upload(request,member);const {artifact}=await result.json();
 if(artifact.size!==size||artifact.digest!==digest)throw Error('Upload hash mismatch');return artifact;
};
try{
 for(let iteration=0;iteration<repeats;iteration++){
  let artifact;
  const uploaded=await measure(async()=>{artifact=await upload();});
  if(values.mode!=='download')report.results.upload.push(uploaded);
  if(values.mode!=='upload'){
   live.jobs=[{modelArtifact:artifact,deadline:Date.now()+3600000,tasks:[{status:'leased',lease:{nodeId:node.id,expiresAt:Date.now()+3600000}}]}];
   report.results.download.push(await measure(async()=>{
    const response=await artifacts.download(new Request('http://localhost/model',{headers:{'x-relay-node':node.id,authorization:'Bearer synthetic-token'}}),artifact.id);
    const reader=response.body.getReader(),hash=createHash('sha256');let received=0,chunks=0;
    while(true){const {value,done}=await reader.read();if(done)break;hash.update(value);received+=value.byteLength;chunks++;}
    if(received!==size||hash.digest('hex')!==digest)throw Error('Download hash mismatch');report.downloadChunks=chunks;
   }));
   live.jobs=[];
  }
  await artifacts.remove(member,artifact.id);
 }
 for(const [mode,rounds]of Object.entries(report.results))if(rounds.length){const ordered=rounds.map(round=>round.elapsedMs).sort((a,b)=>a-b);report[mode+'MedianMs']=ordered[Math.floor(ordered.length/2)];}
 if(values.output)await writeFile(values.output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{db.close();await rm(dataDir,{recursive:true,force:true});}
