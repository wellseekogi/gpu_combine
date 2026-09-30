import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initialState,assertInvariants,hash,LEASE_MS,RelayError} from '../lib/relay/engine.mjs';
import {execute,errorResponse} from '../lib/relay/service.mjs';
import {createParticipation} from '../standalone/participation.mjs';

const now=1700000000000;
const model={name:'Peer model',digest:'a'.repeat(64),runtime:'b'.repeat(64),template:'c'.repeat(64),context:8192,minVram:4096};
const contract={modelDigest:model.digest,runtime:model.runtime,template:model.template};
class MemoryStore {
 constructor(){this.row={revision:0,state:JSON.stringify(initialState(now))};}
 async read(){await Promise.resolve();return {...this.row};}
 async insert(){}
 async compareAndSwap(_pool,revision,state){await Promise.resolve();if(this.row.revision!==revision)return false;this.row={revision:revision+1,state};return true;}
}
const current=store=>JSON.parse(store.row.state);
const book=store=>current(store).books.live;
const command=(action,payload={})=>({mode:'live',action,payload,requestId:crypto.randomUUID()});
const run=(store,action,payload={},options={})=>execute(store,'test',command(action,payload),{now,...options});
const provider=(store,node,action,payload={},time=now+1)=>execute(store,'test',{mode:'live',action,payload,nodeId:node.id,token:node.token},{provider:true,now:time});
async function setup(){
 const store=new MemoryStore(),alice='member-'+crypto.randomUUID(),bob='member-'+crypto.randomUUID();
 for(const account of [alice,bob])await run(store,'member-account',{account,initialCredit:100});
 const {result:{modelId}}=await run(store,'model',model);
 const nodes=[];
 for(const owner of [bob,alice]){
  const token=crypto.randomUUID()+crypto.randomUUID();
  const {result:{nodeId}}=await run(store,'node',{name:owner===bob?'Peer GPU':'Own GPU',modelId,vram:8192},{ownerAccount:owner,nodeTokenHash:await hash(token)});
  nodes.push({id:nodeId,token,owner});
 }
 const peer=nodes[0],own=nodes[1];
 for(const node of nodes)await provider(store,node,'poll',{...contract,capabilities:['chat']});
 const payload={modelId,allowedNodes:[peer.id],messages:[{role:'user',content:'Write a small JavaScript example.'}],maxTokens:512,publicData:true};
 return {store,alice,bob,peer,own,payload};
}
async function claimChat(store,peer){return (await provider(store,peer,'poll',{...contract,capabilities:['chat']},now+2)).result.task;}
function answer(task,extra={}){return {...contract,taskId:task.taskId,attemptId:task.lease.attemptId,epoch:task.lease.epoch,raw:'const hello = "world";\nconsole.log(hello);',finishReason:'stop',usage:{prompt_tokens:20,completion_tokens:12},...extra};}

test('peer chat leases full messages and settles generated text once, without document validation',async()=>{
 const {store,alice,bob,peer,payload}=await setup();
 const request=command('chat',{...payload,payer:'requester'});
 const created=await execute(store,'test',request,{memberAccount:alice,now});
 const replay=await execute(store,'test',request,{memberAccount:alice,now});
 assert.equal(replay.result.jobId,created.result.jobId);assert.equal(replay.result.duplicate,true);
 assert.equal(book(store).jobs.length,1);assert.equal(book(store).jobs[0].payer,alice);
 assert.equal(book(store).jobs[0].reserved,10);assert.deepEqual(book(store).jobs[0].documents,[]);
 const task=await claimChat(store,peer);
 assert.equal(task.kind,'chat');assert.deepEqual(task.messages,payload.messages);assert.equal(task.maxOutputTokens,512);
 assert.equal(task.tariff.version,'chat-v1');assert.equal(task.document,undefined);
 const submitted=answer(task);
 const results=await Promise.all([provider(store,peer,'submit',submitted,now+3),provider(store,peer,'submit',submitted,now+3)]);
 assert.equal(results[0].result.receipt,results[1].result.receipt);
 const live=book(store),job=live.jobs[0],result=job.tasks[0];
 assert.equal(job.status,'completed');assert.equal(job.spent,10);assert.equal(job.reserved,0);
 assert.equal(result.quality,'generated');assert.equal(result.output,submitted.raw);assert.equal(result.finishReason,'stop');
 assert.equal(result.items,undefined);assert.equal(result.raw,undefined);
 assert.equal(live.accounts[alice],90);assert.equal(live.accounts[bob],109);assert.equal(live.accounts.operator,1);
 assert.equal(live.ledger.filter(entry=>entry.taskId===task.taskId).length,1);
 await assert.rejects(provider(store,peer,'submit',{...submitted,finishReason:'length'},now+4),error=>error.status===409);
 assertInvariants(current(store));
});

test('legacy providers cannot receive or renew a chat lease and capability removal is visible',async()=>{
 const {store,alice,peer,payload}=await setup();
 await run(store,'chat',payload,{memberAccount:alice});
 assert.equal((await provider(store,peer,'poll',contract,now+2)).result.task,null);
 assert.deepEqual(book(store).nodes[0].capabilities,[]);
 await assert.rejects(run(store,'chat',payload,{memberAccount:alice}),error=>error.status===409);
 const task=await claimChat(store,peer);
 assert.equal(task.kind,'chat');
 assert.equal((await provider(store,peer,'poll',contract,now+3)).result.task,null);
 await assert.rejects(provider(store,peer,'poll',{...contract,attemptId:task.lease.attemptId,epoch:task.lease.epoch},now+4),error=>error.status===409);
 assert.equal(book(store).jobs[0].tasks[0].status,'leased');
 assertInvariants(current(store));
});

test('chat member ownership forbids own GPUs, forged payment and reading or cancelling other chats',async()=>{
 const {store,alice,bob,peer,own,payload}=await setup();
 await assert.rejects(run(store,'chat',{...payload,allowedNodes:[own.id]},{memberAccount:alice}),error=>error.status===409);
 const created=await run(store,'chat',{...payload,payer:bob},{memberAccount:alice});
 assert.equal(book(store).jobs[0].payer,alice);
 assert.deepEqual(created.state.books.live.nodes.find(node=>node.id===peer.id).capabilities,['chat']);
 assert.equal((await run(store,'tick',{}, {memberAccount:bob})).state.books.live.jobs.length,0);
 await assert.rejects(run(store,'cancel',{jobId:created.result.jobId},{memberAccount:bob}),error=>error.status===404);
 const ownPoll=await provider(store,own,'poll',{...contract,capabilities:['chat']},now+2);
 assert.equal(ownPoll.result.task,null);
 assertInvariants(current(store));
});

test('cancelled and expired chat leases reject stale answers without charging twice',async()=>{
 const {store,alice,peer,payload}=await setup();
 const first=await run(store,'chat',payload,{memberAccount:alice});
 const cancelled=await claimChat(store,peer);
 await run(store,'cancel',{jobId:first.result.jobId},{memberAccount:alice,now:now+3});
 await assert.rejects(provider(store,peer,'submit',answer(cancelled),now+4),error=>error.status===409);
 assert.equal(book(store).accounts[alice],100);assert.equal(book(store).jobs[0].reserved,0);
 await run(store,'chat',payload,{memberAccount:alice,now:now+5});
 const expired=(await provider(store,peer,'poll',{...contract,capabilities:['chat']},now+6)).result.task;
 const replacement=(await provider(store,peer,'poll',{...contract,capabilities:['chat']},now+6+LEASE_MS)).result.task;
 assert.notEqual(replacement.lease.attemptId,expired.lease.attemptId);
 await assert.rejects(provider(store,peer,'submit',answer(expired),now+7+LEASE_MS),error=>error.status===409);
 await provider(store,peer,'submit',answer(replacement,{finishReason:'length'}),now+7+LEASE_MS);
 assert.equal(book(store).accounts[alice],90);assert.equal(book(store).jobs[0].tasks[0].finishReason,'length');
 assertInvariants(current(store));
});

test('invalid chat inputs and unsupported completion shapes cannot reserve or settle funds',async()=>{
 const {store,alice,peer,payload}=await setup();
 const badInputs=[{messages:[]},{messages:[{role:'tool',content:'x'}]},{messages:[{role:'assistant',content:'x'}]},{messages:[{role:'user',content:['x']}]},{messages:[{role:'user',content:'x',tool_calls:[]}]},{messages:[{role:'user',content:'x'.repeat(16001)}]},{maxTokens:4097},{maxTokens:0},{publicData:false}];
 for(const bad of badInputs)await assert.rejects(run(store,'chat',{...payload,...bad},{memberAccount:alice}));
 await assert.rejects(execute(store,'test',{...command('chat',payload),mode:'demo'},{now}),error=>error.status===400);
 assert.equal(book(store).jobs.length,0);assert.equal(book(store).accounts[alice],100);
 await run(store,'chat',payload,{memberAccount:alice});
 const task=await claimChat(store,peer);
 for(const bad of [{raw:' '},{raw:'x'.repeat(32769)},{raw:'\u0000'.repeat(8000)},{finishReason:'tool_calls'},{modelDigest:'wrong'}])await assert.rejects(provider(store,peer,'submit',answer(task,bad),now+3));
 assert.equal(book(store).accounts[alice],100);assert.equal(book(store).jobs[0].tasks[0].status,'leased');
 await provider(store,peer,'submit',answer(task),now+4);
 await run(store,'archive',{jobId:book(store).jobs[0].id},{memberAccount:alice,now:now+5});
 assert.equal(book(store).jobs[0].messages,undefined);assert.equal(book(store).jobs[0].tasks[0].output,undefined);
 assertInvariants(current(store));
});

test('long multilingual chat answers settle once without the old document result limit',async()=>{
 const {store,alice,peer,payload}=await setup();
 await run(store,'chat',payload,{memberAccount:alice});
 const task=await claimChat(store,peer),raw='한'.repeat(5000);
 const result=await provider(store,peer,'submit',answer(task,{raw}),now+3);
 assert.equal(result.result.quality,'generated');
 assert.equal(book(store).jobs[0].tasks[0].output,raw);
 assert.equal(book(store).accounts[alice],90);
 assertInvariants(current(store));
});

test('renter model has independent digest/context and renewable download, load and run stages',async()=>{
 const {store,alice,peer,payload}=await setup();
 const modelArtifact={id:crypto.randomUUID(),name:'my-model.gguf',digest:'d'.repeat(64),size:1234567};
 const rental={...payload,modelId:undefined,artifactId:modelArtifact.id,context:4096};
 await assert.rejects(run(store,'chat',rental,{memberAccount:alice,modelArtifact}),error=>error.status===409);
 await provider(store,peer,'poll',{...contract,capabilities:['chat','renter-model']});
 await assert.rejects(run(store,'chat',rental,{memberAccount:alice}),error=>error.status===403);
 await assert.rejects(run(store,'chat',{...rental,context:16384},{memberAccount:alice,modelArtifact}));
 await assert.rejects(run(store,'chat',{...rental,allowedNodes:[peer.id,peer.id]},{memberAccount:alice,modelArtifact}));
 await run(store,'chat',rental,{memberAccount:alice,modelArtifact});
 const task=(await provider(store,peer,'poll',{...contract,capabilities:['chat','renter-model']},now+2)).result.task;
 assert.deepEqual(task.modelArtifact,modelArtifact);assert.equal(task.model.digest,modelArtifact.digest);
 assert.equal(task.model.runtime,model.runtime);assert.equal(task.model.template,null);assert.equal(task.model.context,4096);
 assert.equal(task.lease.hardStop,now+3600000);assert.equal(book(store).jobs[0].tasks[0].stage,'downloading');
 for(const [index,stage] of ['downloading','loading','running'].entries()){
  await provider(store,peer,'poll',{...contract,capabilities:['chat','renter-model'],attemptId:task.lease.attemptId,epoch:task.lease.epoch,stage},now+3+index);
  assert.equal(book(store).jobs[0].tasks[0].stage,stage);
 }
 await assert.rejects(provider(store,peer,'submit',answer(task),now+6),error=>error.status===409,'provider baseline model cannot satisfy rented model');
 const submitted=answer(task,{modelDigest:modelArtifact.digest,template:'e'.repeat(64)});
 await provider(store,peer,'submit',submitted,now+7);
 const job=book(store).jobs[0];assert.equal(job.status,'completed');assert.equal(job.tasks[0].templateDigest,'e'.repeat(64));
 assert.equal(job.tasks[0].stage,undefined);assert.equal(job.workflow,'renter-model-v1');
 assertInvariants(current(store));
});

test('GPU-only zero placeholder contracts cannot reserve document jobs but accept an uploaded renter model',async()=>{
 const {store,alice,bob}=await setup();
 const zeros='0'.repeat(64);
 const {result:{modelId}}=await run(store,'model',{...model,name:'GPU-only runtime',digest:zeros,template:zeros,minVram:0});
 const token=crypto.randomUUID()+crypto.randomUUID();
 const {result:{nodeId}}=await run(store,'node',{name:'GPU without a provider model',modelId,vram:4096},{ownerAccount:bob,nodeTokenHash:await hash(token)});
 const peer={id:nodeId,token};
 await provider(store,peer,'poll',{modelDigest:zeros,runtime:model.runtime,template:zeros,capabilities:['renter-model']});
 await assert.rejects(run(store,'create',{title:'Invalid placeholder extraction',modelId,allowedNodes:[nodeId],fields:['license'],documents:[{title:'Source',text:'license: MIT'}],publicData:true,budget:10},{memberAccount:alice}),error=>error.status===400&&error.message.includes('GGUF'));
 assert.equal(book(store).jobs.length,0);assert.equal(book(store).accounts[alice],100);
 const modelArtifact={id:crypto.randomUUID(),name:'uploaded.gguf',digest:'d'.repeat(64),size:1024};
 await run(store,'chat',{artifactId:modelArtifact.id,allowedNodes:[nodeId],messages:[{role:'user',content:'Run my own model.'}],context:4096,maxTokens:64,publicData:true},{memberAccount:alice,modelArtifact});
 assert.equal(book(store).jobs[0].model.digest,modelArtifact.digest);assert.equal(book(store).jobs[0].reserved,10);
 assertInvariants(current(store));
});

test('rental failure codes map to bounded messages and exhausted retries release reservations without payment',async()=>{
 const {store,alice,peer,payload}=await setup();
 const modelArtifact={id:crypto.randomUUID(),name:'failing-model.gguf',digest:'d'.repeat(64),size:1024};
 const rental={...payload,artifactId:modelArtifact.id,context:4096};
 const poll={...contract,capabilities:['renter-model']};
 await provider(store,peer,'poll',poll);
 await run(store,'chat',rental,{memberAccount:alice,modelArtifact});
 const cases=[['model-download-failed','모델 전송에 실패했습니다.'],['model-load-failed','모델 적재에 실패했습니다.'],['model-inference-failed','모델 응답 생성에 실패했습니다.']];
 for(const [index,[reasonCode,prefix]] of cases.entries()){
  const task=(await provider(store,peer,'poll',poll,now+2+index*2)).result.task;
  await provider(store,peer,'release',{taskId:task.taskId,attemptId:task.lease.attemptId,epoch:task.lease.epoch,reasonCode,reason:'PRIVATE PROVIDER ERROR MUST NOT LEAK'},now+3+index*2);
  const stored=book(store).jobs[0].tasks[0];
  assert.ok(stored.reason.startsWith(prefix));assert.equal(stored.stage,undefined);assert.equal(stored.lease,undefined);
  assert.ok(!JSON.stringify(book(store)).includes('PRIVATE PROVIDER ERROR'));
 }
 const failed=book(store).jobs[0];assert.equal(failed.status,'partial');assert.equal(failed.tasks[0].status,'failed');
 assert.equal(failed.spent,0);assert.equal(failed.reserved,0);assert.equal(book(store).accounts[alice],100);
 assert.equal(book(store).ledger.filter(entry=>entry.type==='settlement').length,0);
 await run(store,'chat',rental,{memberAccount:alice,modelArtifact,now:now+10});
 const task=(await provider(store,peer,'poll',poll,now+11)).result.task;
 await provider(store,peer,'release',{taskId:task.taskId,attemptId:task.lease.attemptId,epoch:task.lease.epoch,reasonCode:'toString'},now+12);
 assert.equal(book(store).jobs[0].tasks[0].reason,'제공자 중단');
 await run(store,'cancel',{jobId:book(store).jobs[0].id},{memberAccount:alice,now:now+13});
 assert.equal(book(store).jobs[0].reserved,0);assertInvariants(current(store));
});

test('a rented GPU stays reserved across turns and charges measured tokens once per answer',async()=>{
 const {store,alice,bob,peer}=await setup();
 const capabilities=['renter-model','rental-session'],artifact={id:crypto.randomUUID(),name:'rental.gguf',digest:'d'.repeat(64),size:1024};
 const poll={...contract,capabilities};
 await provider(store,peer,'poll',poll);
 const created=await run(store,'rent',{artifactId:artifact.id,allowedNodes:[peer.id],context:4096,publicData:true,systemPrompt:'Be concise.'},{memberAccount:alice,modelArtifact:artifact});
 const rentalId=created.result.jobId;
 assert.equal(book(store).jobs[0].rentalStage,'loading');
 await assert.rejects(run(store,'chat',{rentalId,prompt:'too soon'},{memberAccount:alice}),e=>e.status===409);
 await assert.rejects(run(store,'chat',{rentalId,prompt:'intrusion'},{memberAccount:bob}),e=>e.status===404);
 const prepared=(await provider(store,peer,'poll',poll,now+2)).result;
 assert.equal(prepared.rental.id,rentalId);assert.equal(prepared.rental.modelArtifact.id,artifact.id);
 await provider(store,peer,'poll',{...poll,rentalId,rentalStage:'ready'},now+3);
 const first=await run(store,'chat',{rentalId,prompt:'Hello',maxTokens:512},{memberAccount:alice,now:now+4});
 assert.equal(first.result.reserved,5);
 const reconnect=(await provider(store,peer,'poll',poll,now+5)).result;
 assert.equal(reconnect.task,null);assert.equal(reconnect.rental.id,rentalId);assert.equal(book(store).jobs[0].rentalStage,'loading');
 const task1=(await provider(store,peer,'poll',{...poll,rentalId,rentalStage:'ready'},now+5)).result.task;
 assert.equal(task1.rentalId,rentalId);assert.deepEqual(task1.messages,[{role:'system',content:'Be concise.'},{role:'user',content:'Hello'}]);
 const response1={...answer(task1),modelDigest:artifact.digest,template:'e'.repeat(64),raw:'Hi',usage:{prompt_tokens:50,completion_tokens:25,total_tokens:75}};
 await assert.rejects(provider(store,peer,'submit',{...response1,usage:{...response1.usage,total_tokens:1}},now+6),e=>e.status===409);
 const settled1=await provider(store,peer,'submit',response1,now+7);
 assert.equal((await provider(store,peer,'submit',response1,now+7)).result.receipt,settled1.result.receipt);
 assert.equal(book(store).jobs[0].spent,1);assert.equal(book(store).accounts[alice],99);
 await run(store,'chat',{rentalId,prompt:'More',maxTokens:512},{memberAccount:alice,now:now+8});
 const task2=(await provider(store,peer,'poll',{...poll,rentalId,rentalStage:'ready'},now+9)).result.task;
 assert.deepEqual(task2.messages.at(-2),{role:'assistant',content:'Hi'});
 await provider(store,peer,'submit',{...answer(task2),modelDigest:artifact.digest,template:'e'.repeat(64),raw:'More detail',usage:{prompt_tokens:2100,completion_tokens:250,total_tokens:2350,prompt_tokens_details:{cached_tokens:1200}}},now+10);
 const job=book(store).jobs[0];
 assert.deepEqual(job.tasks.map(task=>task.messages),[[{role:'user',content:'Hello'}],[{role:'user',content:'More'}]],'settled history retains each prompt without duplicating previous turns');
 assert.deepEqual(job.messages,[{role:'system',content:'Be concise.'},{role:'user',content:'Hello'},{role:'assistant',content:'Hi'},{role:'user',content:'More'},{role:'assistant',content:'More detail'}]);
 assert.equal(job.spent,3);assert.equal(job.reserved,0);assert.equal(book(store).accounts[alice],97);assert.equal(book(store).accounts[bob],103);
 assert.equal(job.tasks[1].usage.billable_tokens,1150);
 assert.equal(book(store).ledger.filter(entry=>entry.tariff==='rental-token-v1').length,2);
 await run(store,'cancel',{jobId:rentalId},{memberAccount:alice,now:now+11});
 assert.equal((await provider(store,peer,'poll',poll,now+12)).result.rental,null);
 await assert.rejects(run(store,'chat',{rentalId,prompt:'after stop'},{memberAccount:alice,now:now+13}),e=>e.status===409);
 await run(store,'archive',{jobId:rentalId},{memberAccount:alice,now:now+14});
 assert.ok(!JSON.stringify(book(store).jobs[0]).includes('Hello'));
 assert.ok(!JSON.stringify(book(store).jobs[0]).includes('More detail'));
 assertInvariants(current(store));
});

test('member HTTP command authenticates chat, advertises capabilities, and binds the payer',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE relay_pools(id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL)');
 const store={read:async id=>db.prepare('SELECT revision,state FROM relay_pools WHERE id=?').get(id),insert:async(id,state)=>db.prepare('INSERT OR IGNORE INTO relay_pools(id,revision,state) VALUES (?,0,?)').run(id,state),compareAndSwap:async(id,revision,state)=>db.prepare('UPDATE relay_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?').run(state,id,revision).changes===1};
 const artifact={id:crypto.randomUUID(),name:'renter-owned.gguf',digest:'d'.repeat(64),size:12345};
 let artifactOwner;
 const artifacts={getOwned(member,id){if(member.id!==artifactOwner||id!==artifact.id)throw new RelayError('Uploaded model not found',404);return artifact;},list:member=>({artifacts:member.id===artifactOwner?[artifact]:[],maxFileBytes:1000000})};
 artifacts.withOwned=(member,id,operation)=>operation(artifacts.getOwned(member,id));
 const handler=createParticipation({db,store,root:process.cwd(),identity:()=>{throw Error('unused');},limit:()=>{},coordinator:()=> 'https://relay.example',artifacts,now:()=>now});
 const call=async(path,body,user)=>{
  const request=new Request('https://relay.example'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(user?{'x-relay-member':user.id,authorization:'Bearer '+user.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  let response;try{response=await handler(request,'127.0.0.1');}catch(error){response=errorResponse(error);}
  return {status:response.status,body:await response.json()};
 };
 try{
  const alice={id:crypto.randomUUID(),token:crypto.randomUUID()+crypto.randomUUID(),name:'Alice'},bob={id:crypto.randomUUID(),token:crypto.randomUUID()+crypto.randomUUID(),name:'Bob'};
  artifactOwner=alice.id;
  for(const user of [alice,bob])assert.equal((await call('/api/member/register',user)).status,200);
  const token=crypto.randomUUID()+crypto.randomUUID();
  const registered=await call('/api/member/devices',{requestId:crypto.randomUUID(),token,name:'Peer GPU',modelName:model.name,model,vram:8192},bob);
  assert.equal(registered.status,200);
  const live=JSON.parse((await store.read('local-owner')).state).books.live,node=live.nodes[0];
  await execute(store,'local-owner',{mode:'live',action:'poll',nodeId:node.id,token,payload:{...contract,capabilities:['chat','renter-model']}},{provider:true,now});
  const offers=await call('/api/member/offers');assert.deepEqual(offers.body.offers[0].capabilities,['chat','renter-model']);
  assert.deepEqual((await call('/api/member/models',undefined,alice)).body.artifacts,[artifact]);
  assert.deepEqual((await call('/api/member/models',undefined,bob)).body.artifacts,[]);
  const request={action:'chat',requestId:crypto.randomUUID(),payload:{artifactId:artifact.id,allowedNodes:[node.id],context:4096,messages:[{role:'user',content:'Hello from another account'}],maxTokens:128,publicData:true,payer:'requester'}};
  assert.equal((await call('/api/member/command',request)).status,401);
  const created=await call('/api/member/command',request,alice);assert.equal(created.status,200);
  assert.equal(created.body.state.books.live.jobs[0].payer,'member-'+alice.id);
  assert.equal((await call('/api/member/command',{...request,requestId:crypto.randomUUID()},bob)).status,404);
  assert.equal((await call('/api/member/command',{...request,requestId:crypto.randomUUID(),payload:{...request.payload,artifactId:undefined,modelArtifact:artifact}},alice)).status,404);
  assert.equal((await call('/api/member/me',undefined,bob)).body.state.books.live.jobs.length,0);
  assertInvariants(JSON.parse((await store.read('local-owner')).state));
 }finally{db.close();}
});
