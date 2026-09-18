// Pure, deterministic state transitions. All mutations are committed with a DB revision fence.
export class RelayError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const fail=(ok,message,status=400)=>{if(!ok)throw new RelayError(message,status)};
export const TARIFF={version:"document-v1",price:10,provider:9,operator:1};
export const LEASE_MS=30000;
const id=()=>crypto.randomUUID();
const bounded=(s,n,label)=>{fail(typeof s==="string"&&s.trim().length>0&&s.length<=n,label+" 형식을 확인하세요.");return s.trim()};
const integer=(v,a,b,label)=>{fail(Number.isSafeInteger(v)&&v>=a&&v<=b,label+" 범위를 확인하세요.");return v};
const shaPattern=/^[a-f0-9]{64}$/;
export async function hash(text){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,"0")).join("")}
function book(mode,now){
 const b={mode,accounts:{requester:1000,operator:0},issued:1000,jobs:[],nodes:[],models:[],ledger:[{id:id(),type:"grant",at:now,amount:1000,to:"requester",note:"운영자 시작 보조금 · 1회 발행"}],events:[]};
 if(mode==="demo"){b.models.push({id:"fixture-v1",name:"구조화 추출 체험",digest:"fixture-v1",runtime:"fixture-v1",template:"fixture-v1",context:8192,minVram:0});["Atlas","Boreal","Cedar"].forEach((name,i)=>b.nodes.push({id:"demo-"+i,name,account:"demo-provider-"+i,mode,model:"fixture-v1",vram:0,context:8192,status:"online",lastSeen:now,slots:1,earned:0,failures:0,completed:0,latency:4+i*2}));}
 return b;
}
export function initialState(now=Date.now()){return {version:1,books:{demo:book("demo",now),live:book("live",now)},receipts:[]};}
function event(b,now,message,kind="info",jobId=null){b.events.unshift({id:id(),at:now,message,kind,jobId});b.events=b.events.slice(0,100);}
export function outstanding(b,account="requester"){return b.jobs.filter(j=>(j.payer??"requester")===account).flatMap(j=>j.tasks).filter(t=>["ready","leased"].includes(t.status)).length*TARIFF.price}
export function available(b,account="requester"){return (b.accounts[account]??0)-outstanding(b,account);}
function jobFor(b,jid){const j=b.jobs.find(x=>x.id===jid);fail(j,"작업을 찾을 수 없습니다.",404);return j}
function taskFor(b,tid){for(const j of b.jobs){const t=j.tasks.find(t=>t.id===tid);if(t)return {j,t};}throw new RelayError("실행 단계를 찾을 수 없습니다.",404)}
function nodeFor(b,nid){const n=b.nodes.find(x=>x.id===nid);fail(n,"노드를 찾을 수 없습니다.",404);return n}
const terminal=t=>["settled","failed","cancelled"].includes(t.status);
function finish(j,now){
 const active=j.documents.map(d=>j.tasks.find(t=>t.id===d.taskId));
 j.spent=j.tasks.filter(t=>t.status==="settled").length*TARIFF.price;
 j.reserved=j.tasks.filter(t=>["ready","leased"].includes(t.status)).length*TARIFF.price;
 if(j.cancelled){j.status="cancelled";j.finishedAt??=now;}
 else if(active.every(terminal)){j.status=active.every(t=>t.status==="settled"&&t.quality==="passed")?"completed":"partial";j.finishedAt??=now;}
 else {j.status=active.some(t=>t.status==="leased")?"running":"queued";delete j.finishedAt;}
}
function abandon(b,j,t,now,reason){
 const a=t.attempts.at(-1);
 if(a&&a.status==="leased"){a.status="expired";a.finishedAt=now;a.reason=reason;}
 t.status=t.attempts.length<j.retryLimit&&now<j.deadline&&!j.cancelled?"ready":"failed";
 t.reason=reason;delete t.lease;finish(j,now);
 event(b,now,(t.status==="ready"?"미완료 단계 재배치":"단계 종료")+" · "+reason,"recovery",j.id);
}
export function sweep(b,now){
 for(const j of b.jobs){if(j.archived)continue;for(const t of j.tasks){
 if(t.status==="leased"&&t.lease.expiresAt<=now)abandon(b,j,t,now,"lease 만료");
 if(["ready","leased"].includes(t.status)&&j.deadline<=now){if(t.lease)abandon(b,j,t,now,"완료 기한 경과");t.status="failed";t.reason="완료 기한 경과";delete t.lease;}
 }finish(j,now);}
}
function grant(b,n,j,t,now){
 const a={id:id(),epoch:t.attempts.length+1,nodeId:n.id,startedAt:now,status:"leased"};
 t.attempts.push(a);t.status="leased";t.lease={attemptId:a.id,epoch:a.epoch,nodeId:n.id,expiresAt:now+LEASE_MS,hardStop:now+180000};
 finish(j,now);event(b,now,n.name+"에 문서 할당","dispatch",j.id);
 return {jobId:j.id,taskId:t.id,lease:{...t.lease},document:j.documents.find(d=>d.id===t.documentId),fields:j.fields,model:b.models.find(m=>m.id===j.modelId),maxOutputTokens:1024,tariff:TARIFF};
}
function claim(b,n,now){
 if(n.status!=="online")return null;
 const existing=b.jobs.flatMap(j=>j.tasks.map(t=>({j,t}))).find(({t})=>t.status==="leased"&&t.lease.nodeId===n.id);
 if(existing)return grantView(b,existing.j,existing.t);
 const candidates=b.jobs.filter(j=>!j.cancelled&&j.deadline>now&&!j.archived&&j.modelId===n.model&&(!j.allowedNodes.length||j.allowedNodes.includes(n.id))).sort((a,c)=>a.lastAssigned-c.lastAssigned||a.createdAt-c.createdAt);
 for(const j of candidates){const m=b.models.find(m=>m.id===j.modelId);if(n.context<m.context||n.vram<m.minVram)continue;const t=j.tasks.find(t=>t.status==="ready");if(t){j.lastAssigned=now;return grant(b,n,j,t,now);}}
 return null;
}
function grantView(b,j,t){return {jobId:j.id,taskId:t.id,lease:{...t.lease},document:j.documents.find(d=>d.id===t.documentId),fields:j.fields,model:b.models.find(m=>m.id===j.modelId),maxOutputTokens:1024,tariff:TARIFF}}
function fenced(t,nid,p,now){
 fail(t.status==="leased"&&t.lease?.nodeId===nid&&t.lease.attemptId===p.attemptId&&t.lease.epoch===p.epoch&&t.lease.expiresAt>now,"만료되었거나 철회된 실행 권한입니다.",409);
}
function validate(raw,doc,fields){
 try{
 const obj=JSON.parse(raw);fail(obj&&Array.isArray(obj.items)&&obj.items.length<=fields.length,"구조 불일치");
 const seen=new Set();const items=obj.items.map(v=>{
 fail(v&&fields.includes(v.field)&&!seen.has(v.field),"항목 불일치");seen.add(v.field);
 fail(v.value===null||typeof v.value==="string"&&v.value.length<=500,"값 길이");
 fail(v.quote===null||typeof v.quote==="string"&&v.quote.length<=500,"인용 길이");
 if(v.value===null)return {field:v.field,value:null,quote:null,start:null,end:null,verified:false};
 fail(typeof v.quote==="string"&&v.quote.length>0,"근거 누락");const start=doc.text.indexOf(v.quote);fail(start>=0,"원문에 없는 인용");
 return {field:v.field,value:v.value,quote:v.quote,start,end:start+v.quote.length,verified:true};
 });
 for(const field of fields)if(!seen.has(field))items.push({field,value:null,quote:null,verified:false,start:null,end:null});
 return {quality:items.every(x=>x.verified)?"passed":"partial",items,reason:items.every(x=>x.verified)?null:"일부 항목의 근거를 찾지 못했습니다."};
 }catch{return {quality:"failed",items:fields.map(field=>({field,value:null,quote:null,verified:false})),reason:"JSON 구조 또는 원문 인용 검증 실패"}}
}
export function fixture(doc,fields){return JSON.stringify({items:fields.map(field=>{
 const line=doc.text.split("\n").find(l=>l.startsWith(field+":")||l.startsWith(field+"："));
 return {field,value:line?line.slice(field.length+1).trim():null,quote:line||null};
})});}
async function submit(b,n,p,now){
 fail(typeof p.raw==='string'&&p.raw.length>0&&new TextEncoder().encode(p.raw).length<=12000,'결과 크기 제한을 초과했습니다.');
 const rawHash=await hash(p.raw);
 const {j,t}=taskFor(b,p.taskId);
 if(t.status==="settled"){fail(t.acceptedAttempt===p.attemptId&&t.acceptedNode===n.id&&t.acceptedEpoch===p.epoch&&t.acceptedRawHash===rawHash,"이미 다른 결과가 수락되었습니다.",409);return {receipt:t.receipt,duplicate:true};}
 fenced(t,n.id,p,now);fail(!j.cancelled&&j.deadline>now,"종료된 작업입니다.",409);
 const m=b.models.find(m=>m.id===j.modelId);
 fail(p.modelDigest===m.digest&&p.runtime===m.runtime&&p.template===m.template,"모델·런타임·템플릿 계약이 일치하지 않습니다.",409);
 fail(typeof p.raw==="string"&&p.raw.length>0&&new TextEncoder().encode(p.raw).length<=12000,"결과 크기 제한을 초과했습니다.");
 fail(["stop","length"].includes(p.finishReason),"완료 응답이 아닙니다.");
 const quality=validate(p.raw,j.documents.find(d=>d.id===t.documentId),j.fields);
 const a=t.attempts.at(-1);a.status="accepted";a.finishedAt=now;
 Object.assign(t,quality,{status:"settled",raw:p.raw,acceptedAttempt:p.attemptId,acceptedEpoch:p.epoch,acceptedNode:n.id,receipt:id(),settledAt:now,acceptedRawHash:rawHash,usage:cleanUsage(p.usage)});delete t.lease;
 b.accounts[j.payer??"requester"]-=TARIFF.price;b.accounts[n.account]=(b.accounts[n.account]??0)+TARIFF.provider;b.accounts.operator+=TARIFF.operator;n.earned+=TARIFF.provider;n.completed++;
 b.ledger.push({id:t.receipt,type:"settlement",at:now,taskId:t.id,jobId:j.id,from:j.payer??"requester",to:n.account,amount:TARIFF.price,provider:TARIFF.provider,operator:TARIFF.operator,tariff:TARIFF.version,quality:t.quality});
 event(b,now,"결과 확정 · "+TARIFF.price+" CR 정산",quality.quality==="passed"?"success":"warning",j.id);finish(j,now);
 return {receipt:t.receipt,duplicate:false,quality:t.quality};
}
function cleanUsage(usage){if(usage==null)return null;const result={};for(const k of ['prompt_tokens','completion_tokens','total_tokens']){if(usage[k]!==undefined){fail(Number.isSafeInteger(usage[k])&&usage[k]>=0&&usage[k]<=1000000,'사용량 형식을 확인하세요.');result[k]=usage[k];}}return result;}
function newTask(doc){return {id:id(),documentId:doc.id,status:"ready",attempts:[],quality:"pending"};}
export async function transition(state,mode,action,p={},now=Date.now(),provider=null){
 fail(["demo","live"].includes(mode),"실행 환경을 선택하세요.");
 const b=state.books[mode];sweep(b,now);
 if(provider){
 const n=nodeFor(b,provider);
 fail(!n.revoked,"폐기된 노드 키입니다.",403);
 if(action==="status")return {paused:n.status!=="online"};
 if(action==="poll"){
 n.lastSeen=Math.max(n.lastSeen,now);
 const m=b.models.find(m=>m.id===n.model);
 fail(m&&p.modelDigest===m.digest&&p.runtime===m.runtime&&p.template===m.template,"제공자 모델 계약이 일치하지 않습니다.",409);
 const current=b.jobs.flatMap(j=>j.tasks).find(t=>t.status==="leased"&&t.lease.nodeId===n.id);
 if(p.attemptId){
 fail(current,'이전 실행 권한이 만료되었습니다.',409);
 if(current.lease.attemptId===p.attemptId&&current.lease.epoch===p.epoch){current.lease.expiresAt=Math.min(Math.max(current.lease.expiresAt,now+LEASE_MS),current.lease.hardStop);return {lease:current.lease,leaseRemainingMs:current.lease.expiresAt-now,task:null,paused:n.status!=="online"};}
 throw new RelayError("이전 실행 권한이 철회되었습니다.",409);
 }
 return {task:claim(b,n,now),paused:n.status!=="online"};
 }
 if(action==="submit")return submit(b,n,p,now);
 if(action==="release"){const {j,t}=taskFor(b,p.taskId);fenced(t,n.id,p,now);abandon(b,j,t,now,"제공자 중단");return {released:true};}
 throw new RelayError("허용되지 않은 제공자 동작입니다.",403);
 }
 if(action==="tick"){
 if(mode==="demo"){
 for(const n of b.nodes)if(n.status==="online")n.lastSeen=Math.max(n.lastSeen,now);
 for(const j of b.jobs)for(const t of j.tasks)if(t.status==="leased"&&now-t.attempts.at(-1).startedAt>6000){
 const n=nodeFor(b,t.lease.nodeId);const m=b.models.find(m=>m.id===j.modelId);
 await submit(b,n,{taskId:t.id,attemptId:t.lease.attemptId,epoch:t.lease.epoch,raw:fixture(j.documents.find(d=>d.id===t.documentId),j.fields),modelDigest:m.digest,runtime:m.runtime,template:m.template,finishReason:"stop"},now);
 }
 for(const n of b.nodes.filter(n=>n.status==="online").sort((a,c)=>a.latency-c.latency))claim(b,n,now);
 }
 return {};
 }
 if(action==="create"){
 fail(b.jobs.filter(j=>!j.archived).length<24,"보관 중인 작업이 24개입니다. 완료 작업을 내보낸 뒤 보관함으로 이동하세요.");
 fail(p.publicData===true,"공개·비민감 데이터만 제출할 수 있습니다.");
 const title=bounded(p.title,100,"작업 이름");
 fail(Array.isArray(p.fields)&&p.fields.length>=1&&p.fields.length<=6,"추출 항목은 1~6개입니다.");
 const fields=[...new Set(p.fields.map(x=>bounded(x,40,"추출 항목")))];
 fail(Array.isArray(p.documents)&&p.documents.length>=1&&p.documents.length<=4,"문서는 한 번에 1~4개입니다.");
 const payer=p.payer??"requester";fail(payer==="requester"||b.nodes.some(n=>n.account===payer),"결제 계정을 확인하세요.");
 const documents=await Promise.all(p.documents.map(async(d)=>{
 const text=bounded(d.text,4000,"문서 본문");const title=bounded(d.title,120,"문서 제목");
 let url=d.url||"";fail(typeof url==="string"&&url.length<=2048,"출처 URL 길이 제한");if(url){try{const u=new URL(url);fail(["https:","http:"].includes(u.protocol),"출처 주소");url=u.href;}catch{throw new RelayError("출처 주소는 http 또는 https 형식이어야 합니다.");}}
 return {id:id(),title,text,url,hash:await hash(text)};
 }));
 const model=b.models.find(m=>m.id===p.modelId);fail(model,"승인된 모델을 선택하세요.");
 const budget=integer(p.budget,10,1000,"예산");fail(budget>=documents.length*TARIFF.price,"예산이 문서 처리 비용보다 작습니다.");
 fail(available(b,payer)>=documents.length*TARIFF.price,"사용 가능한 잔액이 부족합니다.",409);
 const minutes=integer(p.minutes??30,1,1440,"완료 기한");
 const allowedNodes=Array.isArray(p.allowedNodes)?p.allowedNodes:[];fail(allowedNodes.every(x=>b.nodes.some(n=>n.id===x&&!n.revoked)),"허용 노드를 확인하세요.");
 const j={id:id(),title,mode,payer,workflow:"public-docs-v1",fields,documents,modelId:model.id,model:{...model},budget,deadline:now+minutes*60000,createdAt:now,lastAssigned:0,retryLimit:3,status:"queued",tasks:[],spent:0,reserved:0,allowedNodes};
 for(const doc of documents){const t=newTask(doc);doc.taskId=t.id;j.tasks.push(t);}
 b.jobs.unshift(j);finish(j,now);event(b,now,title+" · "+documents.length+"개 문서 예약","info",j.id);return {jobId:j.id};
 }
 if(action==="cancel"){
 const j=jobFor(b,p.jobId);fail(!j.archived,"보관된 작업입니다.");
 if(["completed","partial","cancelled"].includes(j.status))return {};
 j.cancelled=true;for(const t of j.tasks)if(!terminal(t)){if(t.status==="leased"){t.attempts.at(-1).status="cancelled";t.attempts.at(-1).finishedAt=now;}t.status="cancelled";delete t.lease;}
 finish(j,now);event(b,now,"작업 취소 · 미사용 예약 해제","warning",j.id);return {};
 }
 if(action==="retry"){
 const j=jobFor(b,p.jobId);fail(!j.archived&&!j.cancelled&&j.deadline>now,"재시도할 수 없는 작업입니다.",409);
 const d=j.documents.find(d=>d.id===p.documentId);fail(d,"문서를 찾을 수 없습니다.",404);const old=j.tasks.find(t=>t.id===d.taskId);
 fail(terminal(old)&&!(old.status==="settled"&&old.quality==="passed"),"재호출이 필요하지 않은 문서입니다.");
 fail(j.spent+j.reserved+TARIFF.price<=j.budget&&available(b,j.payer??"requester")>=TARIFF.price,"재호출 예산 또는 잔액이 부족합니다.",409);
 fail(j.tasks.length<16,"작업별 재호출 상한에 도달했습니다.");
 const t=newTask(d);d.taskId=t.id;j.tasks.push(t);finish(j,now);event(b,now,"품질 재호출 · 새 논리 작업으로 예약","info",j.id);return {};
 }
 if(action==="pause"||action==="resume"||action==="revoke"){
 const n=nodeFor(b,p.nodeId);fail(!n.revoked,"이미 폐기된 노드입니다.");
 n.status=action==="resume"?"online":"paused";if(action==="revoke"){n.revoked=true;n.tokenHash=null;}
 if(action!=="resume")for(const j of b.jobs)for(const t of j.tasks)if(t.status==="leased"&&t.lease.nodeId===n.id)abandon(b,j,t,now,action==="revoke"?"노드 키 폐기":"소유자 즉시 회수");
 event(b,now,n.name+" · "+(action==="resume"?"제공 재개":"신규 할당 중지 및 lease 철회"),"recovery");return {};
 }
 if(action==="model"){
 fail(mode==="live","실제 실행 환경에서만 모델을 등록할 수 있습니다.");
 fail(b.models.length<8,"승인 모델 상한은 8개입니다.");
 for(const k of ["digest","runtime","template"])fail(typeof p[k]==="string"&&shaPattern.test(p[k]),"모델·실행파일·템플릿 SHA-256은 64자리 소문자 16진수입니다.");
 const m={id:id(),name:bounded(p.name,100,"모델 이름"),digest:p.digest,runtime:p.runtime,template:p.template,context:integer(p.context,4096,131072,"문맥 크기"),minVram:integer(p.minVram,0,200000,"필요 VRAM")};
 b.models.push(m);event(b,now,"승인 모델 계약 등록");return {modelId:m.id};
 }
 if(action==="node"){
 fail(mode==="live","체험 노드는 자동 제공됩니다.");fail(b.nodes.length<20,"이 풀은 최대 20개 노드를 지원합니다.");
 const m=b.models.find(m=>m.id===p.modelId);fail(m,"승인된 모델을 선택하세요.");
 const n={id:id(),name:bounded(p.name,80,"노드 이름"),account:"provider-"+id(),mode,model:m.id,vram:integer(p.vram,0,200000,"VRAM"),context:m.context,status:"online",lastSeen:0,slots:1,earned:0,completed:0,failures:0,tokenHash:p.tokenHash};
 fail(shaPattern.test(n.tokenHash),"키 생성 실패");fail(n.vram>=m.minVram,"모델에 필요한 VRAM보다 작습니다.");b.nodes.push(n);b.accounts[n.account]=0;event(b,now,"제공자 승인 · "+n.name);return {nodeId:n.id};
 }
 if(action==="archive"){
 const j=jobFor(b,p.jobId);fail(["completed","partial","cancelled"].includes(j.status),"실행 중인 작업은 보관할 수 없습니다.");
 j.archived=true;for(const d of j.documents){delete d.text;}for(const t of j.tasks){delete t.raw;delete t.items;}
 return {};
 }
 throw new RelayError("알 수 없는 동작입니다.");
}
export function assertInvariants(s){
 for(const b of Object.values(s.books)){
 for(const account of Object.keys(b.accounts))fail(available(b,account)>=0,"원장 불변식: 음수 가용 잔액",500);
 fail(Object.values(b.accounts).every(Number.isSafeInteger),"정수 크레딧 불변식",500);
 fail(Object.values(b.accounts).reduce((a,c)=>a+c,0)===b.issued,"원장 보존식 위반",500);
 const settled=new Set();const slots=new Set();
 for(const j of b.jobs){fail(j.spent+j.reserved<=j.budget,"작업 예산 불변식",500);
 for(const t of j.tasks){if(t.status==="leased"){fail(!slots.has(t.lease.nodeId),"노드 중복 할당",500);slots.add(t.lease.nodeId);}
 if(t.status==="settled"){fail(!settled.has(t.id),"중복 정산",500);settled.add(t.id);fail(b.ledger.filter(l=>l.taskId===t.id).length===1,"정산 영수증 불변식",500);}
 }}
 fail(b.ledger.filter(l=>l.type==="settlement").length===settled.size,"원장/작업 불일치",500);
 }
}
export function view(s,now=Date.now()){
 const result=structuredClone(s);delete result.receipts;
 for(const b of Object.values(result.books)){b.available=available(b);b.reserved=outstanding(b);b.accountAvailable=Object.fromEntries(Object.keys(b.accounts).map(a=>[a,available(b,a)]));b.nodes.forEach(n=>{delete n.tokenHash;n.connected=n.mode==="demo"||n.lastSeen>now-45000;});}
 return result;
}

