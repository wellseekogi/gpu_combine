import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,assertInvariants,hash,fixture,memberView,TARIFF} from '../lib/relay/engine.mjs';
import {execute,getMemberView,getView} from '../lib/relay/service.mjs';

const now=1700000000000;
const alice='member-'+crypto.randomUUID(),bob='member-'+crypto.randomUUID(),carol='member-'+crypto.randomUUID();
const model={name:'Public GPU offer',digest:'a'.repeat(64),runtime:'b'.repeat(64),template:'c'.repeat(64),context:8192,minVram:4096};
const doc={title:'Public source',text:'license: MIT',url:'https://example.org/source'};
class MemoryStore{
 constructor(){this.row={revision:0,state:JSON.stringify(initialState(now))};this.conflicts=0;}
 async read(){await Promise.resolve();return {...this.row};}
 async insert(){}
 async compareAndSwap(pool,revision,state){await Promise.resolve();if(this.row.revision!==revision){this.conflicts++;return false;}this.row={revision:revision+1,state};return true;}
}
const state=store=>JSON.parse(store.row.state),book=store=>state(store).books.live;
const command=(action,payload={})=>({mode:'live',action,payload,requestId:crypto.randomUUID()});
const run=(store,action,payload={},options={})=>execute(store,'test',command(action,payload),{now,...options});
async function setup({credits=100,aliceNode=false}={}){
 const store=new MemoryStore();
 for(const account of [alice,bob,carol])await run(store,'member-account',{account});
 if(credits)await run(store,'allocate',{account:alice,amount:credits});
 const {result:{modelId}}=await run(store,'model',model);
 const nodes=[];
 for(const [owner,name] of [[bob,'Bob GPU 1'],[bob,'Bob GPU 2'],[carol,'Carol GPU'],...(aliceNode?[[alice,'Alice GPU']]:[])]){
  const token=crypto.randomUUID()+crypto.randomUUID();
  const {result:{nodeId}}=await run(store,'node',{modelId,name,vram:4096},{nodeTokenHash:await hash(token),ownerAccount:owner});
  nodes.push({nodeId,token,owner});
 }
 const job=(extra={})=>({title:'Alice job',fields:['license'],documents:[doc],modelId,publicData:true,budget:100,minutes:30,...extra});
 return {store,modelId,nodes,job};
}
async function provider(store,node,action,payload={}){
 return execute(store,'test',{mode:'live',action,payload,nodeId:node.nodeId,token:node.token},{provider:true,now:now+100});
}
async function settle(store,node){
 const {result:{task}}=await provider(store,node,'poll',{modelDigest:model.digest,runtime:model.runtime,template:model.template});
 assert.ok(task);
 const payload={taskId:task.taskId,attemptId:task.lease.attemptId,epoch:task.lease.epoch,modelDigest:model.digest,runtime:model.runtime,template:model.template,raw:fixture(task.document,task.fields),finishReason:'stop',usage:{completion_tokens:12345}};
 const result=await provider(store,node,'submit',payload);
 return {payload,result};
}

test('member account is zero balance, durable and idempotent without any node',async()=>{
 const store=new MemoryStore(),c=command('member-account',{account:alice});
 const first=await execute(store,'test',c,{now});
 const second=await execute(store,'test',c,{now});
 assert.equal(first.result.created,true);assert.equal(second.result.duplicate,true);
 assert.equal(book(store).accounts[alice],0);assert.equal(book(store).nodes.length,0);
 await run(store,'allocate',{account:alice,amount:25});
 await run(store,'member-account',{account:alice});
 assert.equal(book(store).accounts[alice],25);assert.equal(book(store).accounts.requester,975);
 assertInvariants(state(store));
});

test('authenticated payer binding defeats forged payer and usable member needs no GPU',async()=>{
 const {store,job}=await setup();
 const result=await run(store,'create',job({payer:'requester',ownerAccount:bob,memberAccount:bob}),{memberAccount:alice});
 assert.equal(book(store).jobs[0].payer,alice);assert.equal(result.state.books.live.available,90);
 assert.deepEqual(Object.keys(result.state.books.live.accounts),[alice]);
 assert.equal(book(store).accounts.requester,900);assert.equal(book(store).nodes.some(n=>n.account===alice),false);
 const original=store.row.state;
 await assert.rejects(run(store,'create',job({payer:alice}),{memberAccount:bob}),e=>e.status===409);
 assert.equal(store.row.state,original);assertInvariants(state(store));
});

test('own GPU cannot be chosen or auto allocated when purchasing peer compute',async()=>{
 const {store,job,nodes}=await setup({aliceNode:true});
 const own=nodes.find(n=>n.owner===alice);
 await assert.rejects(run(store,'create',job({allowedNodes:[own.nodeId]}),{memberAccount:alice}),e=>e.status===409);
 await run(store,'create',job(),{memberAccount:alice});
 assert.ok(!book(store).jobs[0].allowedNodes.includes(own.nodeId));
 assert.equal((await provider(store,own,'poll',{modelDigest:model.digest,runtime:model.runtime,template:model.template})).result.task,null);
 await settle(store,nodes[0]);assert.equal(book(store).accounts[alice],90);
});

test('member cannot read or mutate another member jobs, documents, funds or devices',async()=>{
 const {store,job,nodes}=await setup();
 await run(store,'allocate',{account:carol,amount:20});
 const a=await run(store,'create',job({title:'Secret Alice title',documents:[{...doc,text:'license: PRIVATE ALICE CONTENT'}]}),{memberAccount:alice});
 const c=await run(store,'create',job({title:'Carol visible title'}),{memberAccount:carol});
 for(const action of ['cancel','retry','archive'])await assert.rejects(run(store,action,{jobId:a.result.jobId,documentId:book(store).jobs.find(j=>j.id===a.result.jobId).documents[0].id},{memberAccount:carol}),e=>e.status===404);
 for(const action of ['pause','resume','revoke'])await assert.rejects(run(store,action,{nodeId:nodes[0].nodeId},{memberAccount:alice}),e=>e.status===404);
 for(const action of ['allocate','member-account','node','model'])await assert.rejects(run(store,action,{account:alice,amount:100},{memberAccount:carol}),e=>e.status===403);
 await assert.rejects(execute(store,'test',{...command('tick'),mode:'demo'},{memberAccount:alice,now}),e=>e.status===403);
 const snapshot=await getMemberView(store,'test',carol),serialized=JSON.stringify(snapshot);
 assert.ok(!serialized.includes('PRIVATE ALICE CONTENT'));assert.ok(!serialized.includes('Secret Alice title'));
 assert.ok(!serialized.includes('tokenHash'));assert.ok(!serialized.includes(nodes[0].token));
 assert.equal(snapshot.state.books.demo,undefined);assert.equal(snapshot.state.books.live.jobs.length,1);assert.equal(snapshot.state.books.live.jobs[0].id,c.result.jobId);
 assert.deepEqual(Object.keys(snapshot.state.books.live.accounts),[carol]);
 const other=snapshot.state.books.live.nodes.find(n=>n.id===nodes[0].nodeId);assert.equal(other.account,undefined);assert.equal(other.earned,undefined);assert.equal(other.mine,false);
 const mine=snapshot.state.books.live.nodes.find(n=>n.id===nodes[2].nodeId);assert.equal(mine.account,carol);assert.equal(mine.mine,true);
 assert.equal((await getView(store,'test')).state.books.live.jobs.length,2);
});

test('two GPU nodes settle into one member balance without resetting earlier earnings',async()=>{
 const {store,job,nodes,modelId}=await setup();
 await run(store,'create',job({documents:[doc,doc]}),{memberAccount:alice});
 const first=await settle(store,nodes[0]);
 await settle(store,nodes[1]);
 assert.equal(book(store).accounts[bob],18);assert.equal(book(store).accounts[alice],80);assert.equal(book(store).accounts.operator,2);
 const token=crypto.randomUUID()+crypto.randomUUID();
 await run(store,'node',{modelId,name:'Bob GPU 3',vram:4096},{nodeTokenHash:await hash(token),ownerAccount:bob});
 assert.equal(book(store).accounts[bob],18);
 const duplicate=await provider(store,nodes[0],'submit',first.payload);assert.equal(duplicate.result.duplicate,true);assert.equal(book(store).accounts[bob],18);
 const bobView=memberView(state(store),bob,now+101).books.live;
 assert.equal(bobView.ledger.length,2);assert.equal(bobView.jobs.length,0);assert.equal(bobView.ledger[0].jobId,undefined);
 assert.equal(bobView.ledger[0].from,'participant');assert.equal(bobView.available,18);
 await run(store,'create',job({title:'Bob spends earned credit'}),{memberAccount:bob});
 await settle(store,nodes[2]);assert.equal(book(store).accounts[bob],8);assert.equal(book(store).accounts[carol],9);assert.equal(book(store).accounts.operator,3);
 assert.equal(TARIFF.price,10);assertInvariants(state(store));
});

test('simultaneous member reservations cannot spend the same credit twice',async()=>{
 const {store,job}=await setup({credits:10});
 const results=await Promise.allSettled([run(store,'create',job(),{memberAccount:alice}),run(store,'create',job(),{memberAccount:alice})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(book(store).jobs.length,1);assert.ok(store.conflicts>=1);
 const mine=(await getMemberView(store,'test',alice)).state.books.live;assert.equal(mine.available,0);assert.equal(mine.reserved,10);
 await run(store,'cancel',{jobId:book(store).jobs[0].id},{memberAccount:alice});
 assert.equal((await getMemberView(store,'test',alice)).state.books.live.available,10);assertInvariants(state(store));
});

test('credit allocation conserves existing reserve, respects reservations and is idempotent',async()=>{
 const {store,job}=await setup({credits:0});
 await run(store,'create',job({documents:[doc,doc],payer:'requester'}));
 await assert.rejects(run(store,'allocate',{account:alice,amount:981}),e=>e.status===409);
 const c=command('allocate',{account:alice,amount:980});
 await execute(store,'test',c,{now});await execute(store,'test',c,{now});
 assert.equal(book(store).accounts.requester,20);assert.equal(book(store).accounts[alice],980);assert.equal(book(store).issued,1000);
 assert.equal(book(store).ledger.filter(l=>l.type==='allocation').length,1);
 await assert.rejects(run(store,'allocate',{account:bob,amount:1}),e=>e.status===409);
 for(const amount of [0,-1,0.5,NaN,Infinity])await assert.rejects(run(store,'allocate',{account:bob,amount}));
 assertInvariants(state(store));
});

test('owner can pause and revoke own node but cannot bypass revocation with device token',async()=>{
 const {store,job,nodes}=await setup();
 await run(store,'create',job(),{memberAccount:alice});
 await provider(store,nodes[0],'poll',{modelDigest:model.digest,runtime:model.runtime,template:model.template});
 await run(store,'pause',{nodeId:nodes[0].nodeId},{memberAccount:bob});
 assert.equal(book(store).jobs[0].tasks[0].status,'ready');
 await run(store,'resume',{nodeId:nodes[0].nodeId},{memberAccount:bob});
 await run(store,'revoke',{nodeId:nodes[0].nodeId},{memberAccount:bob});
 await assert.rejects(provider(store,nodes[0],'status'),e=>e.status===401);
 assertInvariants(state(store));
});

test('idempotent receipt cannot cross member authentication boundary',async()=>{
 const {store,job}=await setup();
 const c=command('create',job());
 const first=await execute(store,'test',c,{memberAccount:alice,now});
 const again=await execute(store,'test',c,{memberAccount:alice,now});
 assert.equal(first.result.jobId,again.result.jobId);assert.equal(again.result.duplicate,true);
 await assert.rejects(execute(store,'test',c,{memberAccount:carol,now}),e=>e.status===409);
 await assert.rejects(execute(store,'test',command('tick'),{memberAccount:'requester',now}),e=>e.status===403);
 await assert.rejects(getMemberView(store,'test','requester'),e=>e.status===401);
});

test('owned service views preserve durable credentials and default snapshots stay independent',async()=>{
 const {store,job,nodes}=await setup();
 await run(store,'create',job(),{memberAccount:alice});
 const before=store.row.state,copy=state(store);
 const detached=memberView(copy,alice,now);
 detached.books.live.jobs[0].documents[0].text='edited';
 detached.books.live.nodes[0].capabilities.push('edited');
 assert.notEqual(copy.books.live.jobs[0].documents[0].text,'edited');
 assert.ok(!copy.books.live.nodes[0].capabilities?.includes('edited'));
 assert.deepEqual(memberView(state(store),alice,now,{owned:true}),memberView(state(store),alice,now));
 const first=await getMemberView(store,'test',alice),admin=await getView(store,'test');
 first.state.books.live.jobs[0].documents[0].text='changed';
 admin.state.books.live.nodes[0].name='changed';
 assert.equal(store.row.state,before);
 assert.ok(book(store).nodes.every(node=>node.tokenHash));
 const {result:{task}}=await provider(store,nodes[0],'poll',{modelDigest:model.digest,runtime:model.runtime,template:model.template});
 assert.ok(task);
 const live=memberView(state(store),alice,now).books.live;
 assert.equal(live.nodes.find(node=>node.id===nodes[0].nodeId).busy,true);
 assert.equal(live.nodes.find(node=>node.id===nodes[1].nodeId).busy,false);
});


test('configured signup grant mints once across replay and a new registration request',async()=>{
 const store=new MemoryStore(),c=command('member-account',{account:alice,initialCredit:100});
 const first=await execute(store,'test',c,{now});
 const replay=await execute(store,'test',c,{now});
 const repeat=await run(store,'member-account',{account:alice,initialCredit:1000});
 assert.equal(first.result.initialCredit,100);assert.equal(replay.result.duplicate,true);assert.equal(repeat.result.created,false);
 assert.equal(book(store).accounts[alice],100);assert.equal(book(store).accounts.requester,1000);assert.equal(book(store).issued,1100);
 assert.equal(book(store).ledger.filter(l=>l.reason==='signup').length,1);
 const mine=(await getMemberView(store,'test',alice)).state.books.live;
 assert.equal(mine.ledger[0].type,'grant');assert.equal(mine.ledger[0].amount,100);assert.equal(mine.ledger[0].from,undefined);
 assert.equal(mine.available,100);assertInvariants(state(store));
});

test('concurrent account creation grants once and signup amount remains server restricted',async()=>{
 const store=new MemoryStore();
 const results=await Promise.all([run(store,'member-account',{account:alice,initialCredit:100}),run(store,'member-account',{account:alice,initialCredit:100})]);
 assert.equal(results.filter(r=>r.result.created).length,1);assert.equal(book(store).accounts[alice],100);assert.equal(book(store).issued,1100);
 const original=store.row.state;
 await assert.rejects(run(store,'member-account',{account:bob,initialCredit:1000},{memberAccount:alice}),e=>e.status===403);
 await run(store,'tick',{initialCredit:1000,account:alice},{memberAccount:alice});
 assert.equal(book(store).accounts[alice],100);assert.equal(book(store).issued,1100);
 for(const initialCredit of [-1,1001,1.5,'100',NaN,Infinity])await assert.rejects(run(store,'member-account',{account:bob,initialCredit}));
 assert.equal(book(store).accounts[bob],undefined);assert.equal(book(store).ledger.filter(l=>l.reason==='signup').length,1);
 assertInvariants(state(store));
});
