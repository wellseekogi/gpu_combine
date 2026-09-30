// Whole HTTP response pipeline with a paused loopback reader; logical queues are not RSS.
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,open,rm,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import http from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const {values}=parseArgs({options:{module:{type:'string'},output:{type:'string'},direct:{type:'boolean',default:false}}});
const root=resolve(import.meta.dirname,'..'),work=resolve(root,'work'),source=resolve(values.module??resolve(root,'standalone/model-artifacts.mjs'));
const {createModelArtifacts}=await import(pathToFileURL(source));
await mkdir(work,{recursive:true});const dataDir=await mkdtemp(resolve(work,'artifact-backpressure-'));
if(!dataDir.startsWith(work+sep))throw Error('Unsafe benchmark cleanup');
const db=new DatabaseSync(':memory:');
const block=Buffer.alloc(65536,0x61);block.write('GGUF');block.writeUInt32LE(3,4);
const size=16*1024**2,member={id:'synthetic-member'},node={id:'synthetic-node',status:'online',tokenHash:createHash('sha256').update('synthetic-token').digest('hex')};
const live={nodes:[node],jobs:[]},artifacts=createModelArtifacts({db,dataDir,store:{read:async()=>({state:JSON.stringify({books:{live}})})}});
let offset=0;
const upload=await artifacts.upload(new Request('http://localhost/upload',{method:'POST',headers:{'content-length':String(size),'x-model-name':'synthetic.gguf'},body:new ReadableStream({pull(controller){if(offset===size){controller.close();return;}offset+=block.length;controller.enqueue(block);}}),duplex:'half'}),member);
const {artifact}=await upload.json();live.jobs.push({modelArtifact:artifact,deadline:Date.now()+3600000,tasks:[{status:'leased',lease:{nodeId:node.id,expiresAt:Date.now()+3600000}}]});
const probe=await open(resolve(dataDir,'models',artifact.id+'.gguf'),'r'),prototype=Object.getPrototypeOf(probe);await probe.close();
const read=prototype.read;let fileRead=0,handedToResponse=0,inFlight=0,maxInFlight=0,maxReadAhead=0,maxResponseQueue=0,maxLogicalBuffered=0,response;
const sample=()=>{const ahead=fileRead-handedToResponse,queued=response?.writableLength??0;maxInFlight=Math.max(maxInFlight,inFlight);maxReadAhead=Math.max(maxReadAhead,ahead);maxResponseQueue=Math.max(maxResponseQueue,queued);maxLogicalBuffered=Math.max(maxLogicalBuffered,ahead+queued+inFlight);};
prototype.read=async function(buffer,start,length,position){inFlight+=length;sample();try{const result=await read.call(this,buffer,start,length,position);inFlight-=length;fileRead+=result.bytesRead;sample();return result;}catch(error){inFlight-=length;throw error;}};
let transfer;
const server=http.createServer((request,res)=>{response=res;const write=res.write.bind(res);res.write=(chunk,...args)=>{handedToResponse+=chunk.length;const result=write(chunk,...args);sample();return result;};transfer=(async()=>{
 const result=await artifacts.download(new Request('http://localhost/model',{headers:{'x-relay-node':node.id,authorization:'Bearer synthetic-token'}}),artifact.id);
 res.writeHead(result.status,Object.fromEntries(result.headers));await pipeline(values.direct?result.body:Readable.fromWeb(result.body),res);
})().catch(error=>{res.destroy(error);throw error;});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 global.gc?.();const before=process.memoryUsage();
 const received=await new Promise((resolve,reject)=>{const request=http.get('http://127.0.0.1:'+server.address().port,result=>{result.pause();resolve(result);});request.on('error',reject);});
 await new Promise(resolve=>setTimeout(resolve,750));global.gc?.();sample();const paused=process.memoryUsage();
 const pausedRead=fileRead;
 let receivedBytes=0;const hash=createHash('sha256');
 received.on('data',chunk=>{receivedBytes+=chunk.length;hash.update(chunk);});
 await new Promise((resolve,reject)=>{received.on('end',resolve);received.on('error',reject);received.resume();});
 await transfer;
 if(pausedRead>=size)throw Error('Paused client did not backpressure this fixture; increase its size');
 if(receivedBytes!==size||hash.digest('hex')!==artifact.digest)throw Error('Full HTTP download mismatch');
 if(fileRead!==size||handedToResponse!==size)throw Error('File/response instrumentation missed bytes');
 const report={source,directWebPipeline:values.direct,size,fileReadBytes:fileRead,responseWrittenBytes:handedToResponse,pausedReadBytes:pausedRead,maxInFlightReadBytes:maxInFlight,maxReadAheadBytes:maxReadAhead,maxResponseWritableBytes:maxResponseQueue,maxLogicalBufferedBytes:maxLogicalBuffered,pausedArrayBufferIncrease:paused.arrayBuffers-before.arrayBuffers,pausedExternalIncrease:paused.external-before.external,scope:'Actual artifact -> optional Readable.fromWeb -> pipeline -> HTTP ServerResponse with client paused750ms; logical queue counts exclude duplicate backing stores and kernel/TLS buffers. GC snapshot includes both server and loopback client, not production RSS.'};
 if(values.output)await writeFile(values.output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{prototype.read=read;await new Promise(resolve=>server.close(resolve));db.close();await rm(dataDir,{recursive:true,force:true});}
