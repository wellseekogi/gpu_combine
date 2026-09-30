// Pure, deterministic state transitions. All mutations are committed with a DB revision fence.
import {createHash} from "node:crypto";
export class RelayError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const fail=(ok,message,status=400)=>{if(!ok)throw new RelayError(message,status)};
export const TARIFF={version:"document-v1",price:10,provider:9,operator:1};
export const CHAT_TARIFF={version:"chat-v1",price:10,provider:9,operator:1};
export const RENTAL_TARIFF={version:"rental-token-v1",tokensPerCredit:1000};
export const LEASE_MS=30000;
const RESULT_BYTES=12000;
const id=()=>crypto.randomUUID();
const bounded=(s,n,label)=>{fail(typeof s==="string"&&s.trim().length>0&&s.length<=n,label+" 형식을 확인하세요.");return s.trim()};
const integer=(v,a,b,label)=>{fail(Number.isSafeInteger(v)&&v>=a&&v<=b,label+" 범위를 확인하세요.");return v};
const shaPattern=/^[a-f0-9]{64}$/;
export async function hash(text){return createHash("sha256").update(new TextEncoder().encode(text)).digest("hex")}
function book(mode,now){
 const b={mode,accounts:{requester:1000,operator:0},issued:1000,jobs:[],nodes:[],models:[],ledger:[{id:id(),type:"grant",at:now,amount:1000,to:"requester",note:"운영자 시작 보조금 · 1회 발행"}],events:[]};
 if(mode==="demo"){b.models.push({id:"fixture-v1",name:"구조화 추출 체험",digest:"fixture-v1",runtime:"fixture-v1",template:"fixture-v1",context:8192,minVram:0});["Atlas","Boreal","Cedar"].forEach((name,i)=>b.nodes.push({id:"demo-"+i,name,account:"demo-provider-"+i,mode,model:"fixture-v1",vram:0,context:8192,status:"online",lastSeen:now,slots:1,earned:0,failures:0,completed:0,latency:4+i*2}));}
 return b;
}
export function initialState(now=Date.now()){return {version:1,books:{demo:book("demo",now),live:book("live",now)},receipts:[]};}
function event(b,now,message,kind="info",jobId=null){b.events.unshift({id:id(),at:now,message,kind,jobId});b.events=b.events.slice(0,100);}
const taskReserve=(j,t)=>["ready","leased"].includes(t.status)?j.kind==="rental"?t.reserve:TARIFF.price:0;
export function outstanding(b,account="requester"){let sum=0;for(const j of b.jobs)if((j.payer??"requester")===account)for(const t of j.tasks)sum+=taskReserve(j,t);return sum;}
function reservations(b){const sums=new Map();for(const j of b.jobs){const account=j.payer??"requester";let sum=sums.get(account)??0;for(const t of j.tasks)sum+=taskReserve(j,t);sums.set(account,sum);}return sums;}
export function available(b,account="requester"){return (b.accounts[account]??0)-outstanding(b,account);}
function jobFor(b,jid){const j=b.jobs.find(x=>x.id===jid);fail(j,"작업을 찾을 수 없습니다.",404);return j}
function taskFor(b,tid){for(const j of b.jobs){const t=j.tasks.find(t=>t.id===tid);if(t)return {j,t};}throw new RelayError("실행 단계를 찾을 수 없습니다.",404)}
function nodeFor(b,nid){const n=b.nodes.find(x=>x.id===nid);fail(n,"노드를 찾을 수 없습니다.",404);return n}
const terminal=t=>["settled","failed","cancelled"].includes(t.status);
function finish(j,now){
 if(j.kind==="rental"){
 j.spent=j.tasks.reduce((sum,t)=>sum+(t.charge??0),0);
 j.reserved=j.tasks.reduce((sum,t)=>sum+taskReserve(j,t),0);
 j.status=j.cancelled?"cancelled":j.rentalStage==="failed"?"partial":j.rentalStage==="closed"?"completed":"running";
 if(["cancelled","partial","completed"].includes(j.status))j.finishedAt??=now;else delete j.finishedAt;
 return;
 }
 const active=j.kind==="chat"?j.tasks:j.documents.map(d=>j.tasks.find(t=>t.id===d.taskId));
 j.spent=j.tasks.filter(t=>t.status==="settled").length*TARIFF.price;
 j.reserved=j.tasks.filter(t=>["ready","leased"].includes(t.status)).length*TARIFF.price;
 if(j.cancelled){j.status="cancelled";j.finishedAt??=now;}
 else if(active.every(terminal)){j.status=active.every(t=>t.status==="settled"&&t.quality===(j.kind==="chat"?"generated":"passed"))?"completed":"partial";j.finishedAt??=now;}
 else {j.status=active.some(t=>t.status==="leased")?"running":"queued";delete j.finishedAt;}
}
function abandon(b,j,t,now,reason){
 const a=t.attempts.at(-1);
 if(a&&a.status==="leased"){a.status="expired";a.finishedAt=now;a.reason=reason;}
 t.status=t.attempts.length<j.retryLimit&&now<j.deadline&&!j.cancelled?"ready":"failed";
 t.reason=reason;delete t.lease;delete t.stage;finish(j,now);
 event(b,now,(t.status==="ready"?"미완료 단계 재배치":"단계 종료")+" · "+reason,"recovery",j.id);
}
export function sweep(b,now){
 for(const j of b.jobs.filter(j=>j.kind==="rental"&&!["closed","failed"].includes(j.rentalStage)&&!j.cancelled)){
  const n=b.nodes.find(n=>n.id===j.allowedNodes[0]);
  if(!n||n.revoked||n.status!=="online"||n.lastSeen<=now-45000)closeRental(b,j,now,"failed","제공자 연결이 끊겼습니다.");
 }
 for(const j of b.jobs){if(j.archived)continue;for(const t of j.tasks){
 if(t.status==="leased"&&t.lease.expiresAt<=now)abandon(b,j,t,now,"lease 만료");
 if(["ready","leased"].includes(t.status)&&j.deadline<=now){if(t.lease)abandon(b,j,t,now,"완료 기한 경과");t.status="failed";t.reason="완료 기한 경과";delete t.lease;}
 }finish(j,now);}
}
function grant(b,n,j,t,now){
 const a={id:id(),epoch:t.attempts.length+1,nodeId:n.id,startedAt:now,status:"leased"};
 t.attempts.push(a);t.status="leased";if(j.kind==="chat")t.stage=j.modelArtifact?"downloading":"running";
 t.lease={attemptId:a.id,epoch:a.epoch,nodeId:n.id,expiresAt:Math.min(now+LEASE_MS,j.deadline),hardStop:Math.min(now+(j.modelArtifact?3600000:180000),j.deadline)};
 finish(j,now);event(b,now,n.name+(j.kind==="chat"?"에 LLM 요청 할당":"에 문서 할당"),"dispatch",j.id);
 return grantView(b,j,t);
}
function claim(b,n,now){
 if(n.status!=="online")return null;
 const rental=b.jobs.find(j=>j.kind==="rental"&&j.allowedNodes[0]===n.id&&!j.cancelled&&!j.archived&&!j.finishedAt);
 for(const j of b.jobs){const t=j.tasks.find(t=>t.status==="leased"&&t.lease.nodeId===n.id);if(t)return j.kind==="chat"&&!n.capabilities?.includes(j.modelArtifact?"renter-model":"chat")?null:grantView(b,j,t);}
 if(rental)return rental.rentalStage==="ready"&&rental.tasks.find(t=>t.status==="ready")?grant(b,n,rental,rental.tasks.find(t=>t.status==="ready"),now):null;
 const candidates=b.jobs.filter(j=>!j.cancelled&&j.deadline>now&&!j.archived&&j.modelId===n.model&&(j.kind!=="chat"||n.capabilities?.includes(j.modelArtifact?"renter-model":"chat"))&&(!isMemberAccount(j.payer)||j.payer!==n.account)&&(!j.allowedNodes.length||j.allowedNodes.includes(n.id))).sort((a,c)=>a.lastAssigned-c.lastAssigned||a.createdAt-c.createdAt);
 for(const j of candidates){const m=b.models.find(m=>m.id===j.modelId);if(n.context<m.context||n.vram<m.minVram)continue;const t=j.tasks.find(t=>t.status==="ready");if(t){j.lastAssigned=now;return grant(b,n,j,t,now);}}
 return null;
}
function grantView(b,j,t){
 const base={jobId:j.id,taskId:t.id,lease:{...t.lease},model:j.modelArtifact?j.model:b.models.find(m=>m.id===j.modelId)};
 return j.kind==="rental"?{...base,kind:"chat",rentalId:j.id,messages:t.messages,maxOutputTokens:t.maxTokens,tariff:RENTAL_TARIFF,modelArtifact:j.modelArtifact}:j.kind==="chat"?{...base,kind:"chat",messages:j.messages,maxOutputTokens:j.maxTokens,tariff:CHAT_TARIFF,...(j.modelArtifact?{modelArtifact:j.modelArtifact}: {})}:{...base,document:j.documents.find(d=>d.id===t.documentId),fields:j.fields,maxOutputTokens:1024,tariff:TARIFF};
}
function closeRental(b,j,now,stage,reason){
 j.rentalStage=stage;j.rentalReason=reason;
 if(stage==="closed")j.cancelled=true;
 for(const t of j.tasks)if(!terminal(t)){
  if(t.status==="leased"){t.attempts.at(-1).status="cancelled";t.attempts.at(-1).finishedAt=now;}
  t.status="cancelled";delete t.lease;delete t.stage;
 }
 finish(j,now);event(b,now,reason,stage==="failed"?"warning":"info",j.id);
}
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
export function fixture(doc,fields){
 const items=fields.map(field=>({field,value:null,quote:null}));
 const lines=doc.text.split("\n");
 for(const item of items){
 const line=lines.find(l=>l.startsWith(item.field+":")||l.startsWith(item.field+"："));
 // Keep complete, verifiable values only; truncation would claim an incorrect extraction.
 if(!line||line.length>500)continue;
 const value=line.slice(item.field.length+1).trim();
 if(value.length>500)continue;
 item.value=value;item.quote=line;
 if(new TextEncoder().encode(JSON.stringify({items})).length>RESULT_BYTES){item.value=null;item.quote=null;}
 }
 return JSON.stringify({items});
}
async function submit(b,n,p,now){
 const {j,t}=taskFor(b,p.taskId);
 fail(typeof p.raw==='string'&&p.raw.length>0&&new TextEncoder().encode(p.raw).length<=(["chat","rental"].includes(j.kind)?32768:RESULT_BYTES),'결과 크기 제한을 초과했습니다.');
 const rawHash=await hash(p.raw);
 if(t.status==="settled"){fail(t.acceptedAttempt===p.attemptId&&t.acceptedNode===n.id&&t.acceptedEpoch===p.epoch&&t.acceptedRawHash===rawHash&&(!["chat","rental"].includes(j.kind)||t.finishReason===p.finishReason),"이미 다른 결과가 수락되었습니다.",409);return {receipt:t.receipt,duplicate:true};}
 fenced(t,n.id,p,now);fail(!j.cancelled&&j.deadline>now,"종료된 작업입니다.",409);
 const m=j.modelArtifact?j.model:b.models.find(m=>m.id===j.modelId);
 fail(p.modelDigest===m.digest&&p.runtime===m.runtime&&(j.modelArtifact?typeof p.template==="string"&&shaPattern.test(p.template):p.template===m.template),"모델·런타임·템플릿 계약이 일치하지 않습니다.",409);
 fail(["stop","length"].includes(p.finishReason),"완료 응답이 아닙니다.");
 // A generated answer is an execution result, not a citation or accuracy verdict.
 if(["chat","rental"].includes(j.kind))fail(p.raw.trim().length>0&&new TextEncoder().encode(JSON.stringify(p.raw)).length<=48000,"대화 응답 형식 또는 크기를 확인하세요.");
 const quality=["chat","rental"].includes(j.kind)?{quality:"generated",output:p.raw,finishReason:p.finishReason,reason:null}:validate(p.raw,j.documents.find(d=>d.id===t.documentId),j.fields);
 const usage=cleanUsage(p.usage);
 if(j.kind==="rental")fail(usage&&Number.isSafeInteger(usage.prompt_tokens)&&usage.prompt_tokens>0&&Number.isSafeInteger(usage.completion_tokens)&&usage.completion_tokens>0&&usage.completion_tokens<=t.maxTokens&&usage.total_tokens===usage.prompt_tokens+usage.completion_tokens&&usage.total_tokens<=j.model.context,"측정된 토큰 사용량을 확인할 수 없습니다.",409);
 if(j.kind==="rental")usage.billable_tokens=usage.prompt_tokens-(usage.cached_tokens??0)+usage.completion_tokens;
 const charge=j.kind==="rental"?Math.max(1,Math.ceil(usage.billable_tokens/RENTAL_TARIFF.tokensPerCredit)):TARIFF.price;
 fail(charge<=taskReserve(j,t),"예약한 토큰보다 사용량이 많습니다.",409);
 const operator=j.kind==="rental"?Math.floor(charge/10):TARIFF.operator,provider=charge-operator;
 const a=t.attempts.at(-1);a.status="accepted";a.finishedAt=now;
 Object.assign(t,quality,{status:"settled",...(["chat","rental"].includes(j.kind)?{}:{raw:p.raw}),...(j.modelArtifact?{templateDigest:p.template}: {}),acceptedAttempt:p.attemptId,acceptedEpoch:p.epoch,acceptedNode:n.id,receipt:id(),settledAt:now,acceptedRawHash:rawHash,usage,charge});delete t.lease;delete t.stage;
 if(j.kind==="rental"){
  j.messages=[...t.messages,{role:"assistant",content:p.raw}];
  // Only active attempts need the complete prompt. History uses this turn's
  // user message + output; retaining every prefix makes storage quadratic.
  t.messages=t.messages.slice(-1);
 }
 b.accounts[j.payer??"requester"]-=charge;b.accounts[n.account]=(b.accounts[n.account]??0)+provider;b.accounts.operator+=operator;n.earned+=provider;n.completed++;
 b.ledger.push({id:t.receipt,type:"settlement",at:now,taskId:t.id,jobId:j.id,from:j.payer??"requester",to:n.account,amount:charge,provider,operator,tariff:j.kind==="rental"?RENTAL_TARIFF.version:j.kind==="chat"?CHAT_TARIFF.version:TARIFF.version,quality:t.quality,usage:j.kind==="rental"?usage:undefined});
 event(b,now,"결과 확정 · "+charge+" CR 정산",["passed","generated"].includes(quality.quality)?"success":"warning",j.id);finish(j,now);
 return {receipt:t.receipt,duplicate:false,quality:t.quality};
}
function cleanUsage(usage){if(usage==null)return null;const result={};for(const k of ['prompt_tokens','completion_tokens','total_tokens']){if(usage[k]!==undefined){fail(Number.isSafeInteger(usage[k])&&usage[k]>=0&&usage[k]<=1000000,'사용량 형식을 확인하세요.');result[k]=usage[k];}}const details=usage.prompt_tokens_details;if(details!=null)fail(typeof details==='object'&&!Array.isArray(details),'재사용 토큰 사용량을 확인하세요.');const cached=details?.cached_tokens;if(cached!==undefined){fail(Number.isSafeInteger(cached)&&cached>=0&&cached<=result.prompt_tokens,'재사용 토큰 사용량을 확인하세요.');result.cached_tokens=cached;}return result;}
function newTask(doc){return {id:id(),documentId:doc.id,status:"ready",attempts:[],quality:"pending"};}
export async function transition(state,mode,action,p={},now=Date.now(),provider=null,{ownerAccount,modelArtifact}={}){
 fail(["demo","live"].includes(mode),"실행 환경을 선택하세요.");
 fail(p!==null&&typeof p==="object"&&!Array.isArray(p),"동작 입력은 JSON 객체여야 합니다.");
 const b=state.books[mode];sweep(b,now);
 if(provider){
 const n=nodeFor(b,provider);
 fail(!n.revoked,"폐기된 노드 키입니다.",403);
 if(action==="status")return {paused:n.status!=="online"};
 if(action==="poll"){
 n.lastSeen=Math.max(n.lastSeen,now);
 const m=b.models.find(m=>m.id===n.model);
 fail(m&&p.modelDigest===m.digest&&p.runtime===m.runtime&&p.template===m.template,"제공자 모델 계약이 일치하지 않습니다.",409);
 fail(p.capabilities===undefined||Array.isArray(p.capabilities)&&p.capabilities.length<=16&&p.capabilities.every(value=>typeof value==="string"&&/^[a-z][a-z0-9_-]{0,39}$/.test(value)),"제공자 기능 목록을 확인하세요.");
 n.capabilities=["chat","renter-model","rental-session"].filter(value=>p.capabilities?.includes(value));
 const rental=b.jobs.find(j=>j.kind==="rental"&&j.allowedNodes[0]===n.id&&!j.finishedAt&&!j.archived);
 if(rental){
  if(!n.capabilities.includes("rental-session"))closeRental(b,rental,now,"failed","제공자 프로그램이 지속 대여를 지원하지 않습니다.");
  else if(rental.rentalStage==="ready"&&p.rentalId!==rental.id){
   rental.rentalStage="loading";
   for(const t of rental.tasks)if(t.status==="leased")abandon(b,rental,t,now,"제공자 재연결");
  }
  else if(p.rentalId===rental.id){
   fail(["loading","ready","failed"].includes(p.rentalStage),"GPU 대여 준비 상태를 확인하세요.");
   if(p.rentalStage==="failed")closeRental(b,rental,now,"failed","제공자 모델 준비에 실패했습니다.");
   else if(p.rentalStage==="ready")rental.rentalStage="ready";
  }
 }
 const rentalView=rental&&!rental.finishedAt?{id:rental.id,modelArtifact:rental.modelArtifact,model:rental.model,leaseRemainingMs:LEASE_MS}:null;
 const currentJob=b.jobs.find(j=>j.tasks.some(t=>t.status==="leased"&&t.lease.nodeId===n.id));
 const current=currentJob?.tasks.find(t=>t.status==="leased"&&t.lease.nodeId===n.id);
 if(Object.hasOwn(p,"attemptId")||Object.hasOwn(p,"epoch")){
 fail(typeof p.attemptId==="string"&&p.attemptId.trim().length>0&&p.attemptId.length<=80&&Number.isSafeInteger(p.epoch)&&p.epoch>=1,"실행 권한 갱신 형식을 확인하세요.");
 fail(current,'이전 실행 권한이 만료되었습니다.',409);
 fail(current.kind!=="chat"||n.capabilities.includes(currentJob.modelArtifact?"renter-model":"chat"),"이 제공자는 대화 요청을 지원하지 않습니다.",409);
 if(current.lease.attemptId===p.attemptId&&current.lease.epoch===p.epoch){
 if(p.stage!==undefined){fail(currentJob.modelArtifact&&["downloading","loading","running"].includes(p.stage),"모델 실행 단계를 확인하세요.");current.stage=p.stage;}
 current.lease.expiresAt=Math.min(Math.max(current.lease.expiresAt,now+LEASE_MS),current.lease.hardStop);return {lease:current.lease,leaseRemainingMs:current.lease.expiresAt-now,task:null,rental:rentalView,paused:n.status!=="online"};}
 throw new RelayError("이전 실행 권한이 철회되었습니다.",409);
 }
 return {task:claim(b,n,now),rental:rentalView,paused:n.status!=="online"};
 }
 if(action==="submit")return submit(b,n,p,now);
 if(action==="release"){const {j,t}=taskFor(b,p.taskId);fenced(t,n.id,p,now);
 const reasons={"model-download-failed":"모델 전송에 실패했습니다. 제공자 연결과 디스크 공간을 확인하세요.","model-load-failed":"모델 적재에 실패했습니다. GGUF 내장 채팅 템플릿, GPU 메모리와 실행기 호환성을 확인하세요.","model-inference-failed":"모델 응답 생성에 실패했습니다. 문맥 길이와 출력 한도를 줄여 다시 실행하세요."};
 abandon(b,j,t,now,j.modelArtifact&&Object.hasOwn(reasons,p.reasonCode)?reasons[p.reasonCode]:"제공자 중단");return {released:true};}
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
 if(action==="rent"){
 fail(mode==="live"&&modelArtifact&&isMemberAccount(p.payer),"회원의 업로드 모델과 GPU가 필요합니다.",403);
 fail(b.jobs.filter(j=>!j.archived).length<24,"이용 내역 한도에 도달했습니다. 완료한 내역을 저장한 뒤 삭제하세요.",409);
 fail(p.publicData===true,"공개·비민감 모델과 대화만 제공자에게 전달할 수 있습니다.");
 fail(Array.isArray(p.allowedNodes)&&p.allowedNodes.length===1,"빌릴 GPU 한 대를 선택하세요.");
 const n=nodeFor(b,p.allowedNodes[0]),baseModel=b.models.find(m=>m.id===n.model);
 fail(!n.revoked&&n.status==="online"&&n.lastSeen>now-45000&&n.account!==p.payer&&n.capabilities?.includes("rental-session"),"이 GPU에서 지속 대여를 시작할 수 없습니다. 제공자 프로그램과 연결 상태를 확인하세요.",409);
 fail(!b.jobs.some(j=>j.kind==="rental"&&j.allowedNodes[0]===n.id&&!j.finishedAt),"이미 대여 중인 GPU입니다.",409);
 fail(!b.jobs.some(j=>j.tasks.some(t=>t.status==="leased"&&t.lease.nodeId===n.id)),"GPU가 다른 작업을 실행 중입니다.",409);
 fail(available(b,p.payer)>=1,"사용 가능한 토큰이 부족합니다.",409);
 const context=integer(p.context??Math.min(8192,n.context),4096,n.context,"문맥 크기");
 const systemPrompt=p.systemPrompt===undefined||p.systemPrompt===""?null:bounded(p.systemPrompt,16000,"시스템 프롬프트");
 const model={...baseModel,id:modelArtifact.id,name:modelArtifact.name,digest:modelArtifact.digest,template:null,context};
  const j={id:id(),kind:"rental",title:bounded(p.title??modelArtifact.name,100,"대여 이름"),mode,payer:p.payer,workflow:"rental-session-v1",modelId:baseModel.id,model,modelArtifact:{id:modelArtifact.id,name:modelArtifact.name,digest:modelArtifact.digest,size:modelArtifact.size},messages:systemPrompt?[{role:"system",content:systemPrompt}]:[],budget:0,deadline:Number.MAX_SAFE_INTEGER,createdAt:now,lastAssigned:0,retryLimit:2,status:"running",rentalStage:"loading",tasks:[],spent:0,reserved:0,allowedNodes:[n.id],fields:[],documents:[]};
 b.jobs.unshift(j);event(b,now,n.name+" GPU 대여 시작","info",j.id);return {jobId:j.id};
 }
 if(action==="reset-chat"){
 const j=jobFor(b,p.rentalId);fail(j.kind==="rental"&&!j.finishedAt,"사용 중인 GPU 대여를 선택하세요.",409);
 fail(!j.tasks.some(t=>["ready","leased"].includes(t.status)),"답변 생성이 끝난 뒤 대화를 새로 시작하세요.",409);
 j.messages=j.messages.filter(m=>m.role==="system");return {};
 }
 if(action==="chat"){
 if(p.rentalId!==undefined){
  const j=jobFor(b,p.rentalId);
  fail(j.kind==="rental"&&!j.finishedAt&&j.rentalStage==="ready","GPU 모델 준비가 끝난 뒤 대화하세요.",409);
  fail(!j.tasks.some(t=>["ready","leased"].includes(t.status)),"이전 답변이 끝난 뒤 다음 질문을 보내세요.",409);
  const prompt=bounded(p.prompt,16000,"프롬프트"),maxTokens=integer(p.maxTokens??512,1,Math.min(4096,j.model.context-1),"최대 출력 토큰");
  const messages=[...j.messages,{role:"user",content:prompt}];
  fail(messages.length<=64&&new TextEncoder().encode(messages.map(m=>m.content).join("")).length<=48000,"대화 문맥이 길어졌습니다. 새 대화로 시작하세요.",409);
  const reserve=Math.ceil(j.model.context/RENTAL_TARIFF.tokensPerCredit);
  fail(available(b,j.payer)>=reserve,`잔액이 부족합니다. 최대 ${reserve} CR 예약이 필요합니다.`,409);
  const t={id:id(),kind:"chat",status:"ready",attempts:[],quality:"pending",messages,maxTokens,reserve};
  j.tasks.push(t);j.budget+=reserve;finish(j,now);return {jobId:j.id,taskId:t.id,reserved:reserve};
 }
 fail(mode==="live","LLM 대화는 실제 GPU에서 실행합니다.");
 fail(b.jobs.filter(j=>!j.archived).length<24,"원문과 결과를 유지하는 작업이 24개입니다. 필요한 결과를 저장한 뒤 완료 작업의 원문·결과를 삭제하세요.");
 fail(p.publicData===true,"공개·비민감 데이터만 제출할 수 있습니다.");
 const baseModel=b.models.find(m=>m.id===p.modelId);fail(baseModel,"등록된 모델을 선택하세요.");
 const selectedNode=modelArtifact?b.nodes.find(n=>n.id===p.allowedNodes?.[0]):null;
 if(modelArtifact)fail(p.allowedNodes?.length===1&&selectedNode,"모델을 올릴 GPU 한 대를 선택하세요.");
 const model=modelArtifact?{...baseModel,id:modelArtifact.id,name:modelArtifact.name,digest:modelArtifact.digest,template:null,context:integer(p.context??Math.min(8192,selectedNode.context),4096,selectedNode.context,"문맥 크기")}:baseModel;
 fail(Array.isArray(p.messages)&&p.messages.length>=1&&p.messages.length<=64,"대화 기록은 1~64개 메시지입니다.");
 const messages=p.messages.map(message=>{
 fail(message!==null&&typeof message==="object"&&!Array.isArray(message)&&["system","user","assistant"].includes(message.role)&&Object.keys(message).every(key=>["role","content"].includes(key)),"텍스트 대화 메시지 형식을 확인하세요.");
 fail(typeof message.content==="string"&&message.content.trim().length>0&&message.content.length<=16000,"메시지는 1~16,000자입니다.");
 return {role:message.role,content:message.content};
 });
 fail(messages.at(-1).role==="user","마지막 메시지는 사용자 요청이어야 합니다.");
 fail(new TextEncoder().encode(messages.map(message=>message.content).join("")).length<=48000,"대화 기록은 UTF-8 기준 48,000바이트까지입니다.");
 const maxTokens=integer(p.maxTokens??512,1,Math.min(4096,model.context-1),"최대 출력 토큰");
 const payer=p.payer??"requester";fail(payer==="requester"||b.nodes.some(n=>n.account===payer)||isMemberAccount(payer)&&Object.hasOwn(b.accounts,payer),"결제 계정을 확인하세요.");
 fail(available(b,payer)>=TARIFF.price,"사용 가능한 잔액이 부족합니다.",409);
 fail(Array.isArray(p.allowedNodes)&&p.allowedNodes.length>=1&&p.allowedNodes.length<=20,"대화를 실행할 GPU를 선택하세요.");
 const allowedNodes=[...new Set(p.allowedNodes)];
 fail(allowedNodes.every(nodeId=>b.nodes.some(n=>n.id===nodeId&&!n.revoked&&n.model===baseModel.id&&n.capabilities?.includes(modelArtifact?"renter-model":"chat"))),"내 모델 실행을 지원하는 GPU를 선택하세요. 제공자 프로그램을 최신 버전으로 실행해야 합니다.",409);
 const title=bounded(p.title??messages.at(-1).content.trim().slice(0,80),100,"대화 이름");
 const j={id:id(),kind:"chat",title,mode,payer,workflow:modelArtifact?"renter-model-v1":"llm-chat-v1",messages,maxTokens,fields:[],documents:[],modelId:baseModel.id,model:{...model},...(modelArtifact?{modelArtifact:{id:modelArtifact.id,name:modelArtifact.name,digest:modelArtifact.digest,size:modelArtifact.size}}: {}),budget:TARIFF.price,deadline:now+(modelArtifact?60:30)*60000,createdAt:now,lastAssigned:0,retryLimit:3,status:"queued",tasks:[{id:id(),kind:"chat",status:"ready",attempts:[],quality:"pending"}],spent:0,reserved:0,allowedNodes};
 b.jobs.unshift(j);finish(j,now);event(b,now,title+" · LLM 요청 예약","info",j.id);return {jobId:j.id};
 }
 if(action==="create"){
 fail(b.jobs.filter(j=>!j.archived).length<24,"원문과 결과를 유지하는 작업이 24개입니다. 필요한 결과를 저장한 뒤 완료 작업의 원문·결과를 삭제하세요.");
 fail(p.publicData===true,"공개·비민감 데이터만 제출할 수 있습니다.");
 const title=bounded(p.title,100,"작업 이름");
 fail(Array.isArray(p.fields)&&p.fields.length>=1&&p.fields.length<=6,"추출 항목은 1~6개입니다.");
 const fields=[...new Set(p.fields.map(x=>bounded(x,40,"추출 항목")))];
 fail(Array.isArray(p.documents)&&p.documents.length>=1&&p.documents.length<=4,"문서는 한 번에 1~4개입니다.");
 const payer=p.payer??"requester";fail(payer==="requester"||b.nodes.some(n=>n.account===payer)||isMemberAccount(payer)&&Object.hasOwn(b.accounts,payer),"결제 계정을 확인하세요.");
 const documents=await Promise.all(p.documents.map(async(d)=>{
 fail(d!==null&&typeof d==="object"&&!Array.isArray(d),"문서 형식을 확인하세요.");
 const text=bounded(d.text,4000,"문서 본문");const title=bounded(d.title,120,"문서 제목");
 let url=d.url||"";fail(typeof url==="string"&&url.length<=2048,"출처 URL 길이 제한");if(url){try{const u=new URL(url);fail(["https:","http:"].includes(u.protocol),"출처 주소");url=u.href;}catch{throw new RelayError("출처 주소는 http 또는 https 형식이어야 합니다.");}}
 return {id:id(),title,text,url,hash:await hash(text)};
 }));
 const model=b.models.find(m=>m.id===p.modelId);fail(model,"등록된 모델을 선택하세요.");
 fail(!(model.digest==="0".repeat(64)&&model.template==="0".repeat(64)),"GPU 전용 실행 환경에는 실행자가 GGUF 모델을 업로드해야 합니다.");
 const budget=integer(p.budget,10,1000,"예산");fail(budget>=documents.length*TARIFF.price,"예산이 문서 처리 비용보다 작습니다.");
 fail(available(b,payer)>=documents.length*TARIFF.price,"사용 가능한 잔액이 부족합니다.",409);
 const minutes=integer(p.minutes??30,1,1440,"완료 기한");
 fail(!Object.hasOwn(p,"allowedNodes")||Array.isArray(p.allowedNodes),"허용 노드 목록은 배열이어야 합니다.");
 const allowedNodes=p.allowedNodes??[];fail(allowedNodes.every(x=>b.nodes.some(n=>n.id===x&&!n.revoked)),"허용 노드를 확인하세요.");
 const j={id:id(),title,mode,payer,workflow:"public-docs-v1",fields,documents,modelId:model.id,model:{...model},budget,deadline:now+minutes*60000,createdAt:now,lastAssigned:0,retryLimit:3,status:"queued",tasks:[],spent:0,reserved:0,allowedNodes};
 for(const doc of documents){const t=newTask(doc);doc.taskId=t.id;j.tasks.push(t);}
 b.jobs.unshift(j);finish(j,now);event(b,now,title+" · "+documents.length+"개 문서 예약","info",j.id);return {jobId:j.id};
 }
 if(action==="cancel"){
 const j=jobFor(b,p.jobId);fail(!j.archived,"보관된 작업입니다.");
 if(j.kind==="rental"){if(!j.finishedAt)closeRental(b,j,now,"closed","GPU 대여 종료");return {};}
 if(["completed","partial","cancelled"].includes(j.status))return {};
 j.cancelled=true;for(const t of j.tasks)if(!terminal(t)){if(t.status==="leased"){t.attempts.at(-1).status="cancelled";t.attempts.at(-1).finishedAt=now;}t.status="cancelled";delete t.lease;delete t.stage;}
 finish(j,now);event(b,now,"작업 취소 · 미사용 예약 해제","warning",j.id);return {};
 }
 if(action==="retry"){
 const j=jobFor(b,p.jobId);fail(!j.archived&&!j.cancelled&&j.deadline>now,"재시도할 수 없는 작업입니다.",409);
 fail(j.kind!=="chat","대화를 다시 생성하려면 새 요청을 보내세요.",409);
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
 if(action!=="resume")for(const j of b.jobs)if(j.kind==="rental"&&j.allowedNodes[0]===n.id&&!j.finishedAt)closeRental(b,j,now,"failed",action==="revoke"?"GPU 연결이 해제되었습니다.":"GPU 소유자가 제공을 중지했습니다.");
 event(b,now,n.name+" · "+(action==="resume"?"제공 재개":"신규 할당 중지 및 lease 철회"),"recovery");return {};
 }
 if(action==="model"){
 fail(mode==="live","실제 실행 환경에서만 모델을 등록할 수 있습니다.");
 fail(b.models.length<8,"등록 모델 상한은 8개입니다.");
 for(const k of ["digest","runtime","template"])fail(typeof p[k]==="string"&&shaPattern.test(p[k]),"모델·실행파일·템플릿 SHA-256은 64자리 소문자 16진수입니다.");
 const m={id:id(),name:bounded(p.name,100,"모델 이름"),digest:p.digest,runtime:p.runtime,template:p.template,context:integer(p.context,4096,131072,"문맥 크기"),minVram:integer(p.minVram,0,200000,"필요 VRAM")};
 b.models.push(m);event(b,now,"모델 계약 등록");return {modelId:m.id};
 }
 if(action==="node"){
 fail(mode==="live","체험 노드는 자동 제공됩니다.");fail(b.nodes.length<20,"이 풀은 최대 20개 노드를 지원합니다.");
 const m=b.models.find(m=>m.id===p.modelId);fail(m,"등록된 모델을 선택하세요.");
 fail(ownerAccount===undefined||isMemberAccount(ownerAccount)&&Object.hasOwn(b.accounts,ownerAccount),"GPU 소유자 계정을 확인하세요.");
 const n={id:id(),name:bounded(p.name,80,"노드 이름"),account:ownerAccount??"provider-"+id(),mode,model:m.id,vram:integer(p.vram,0,200000,"VRAM"),context:m.context,status:"online",lastSeen:0,slots:1,earned:0,completed:0,failures:0,tokenHash:p.tokenHash};
 fail(shaPattern.test(n.tokenHash),"키 생성 실패");fail(n.vram>=m.minVram,"모델에 필요한 VRAM보다 작습니다.");b.nodes.push(n);b.accounts[n.account]??=0;event(b,now,"GPU 제공 등록 · "+n.name);return {nodeId:n.id};
 }
 if(action==="member-account"){
 fail(mode==="live"&&isMemberAccount(p.account),"참여자 계정 형식을 확인하세요.");
 if(Object.hasOwn(b.accounts,p.account))return {account:p.account,created:false,balance:b.accounts[p.account]};
 fail(Object.keys(b.accounts).filter(isMemberAccount).length<512,"참여자 계정 등록 한도에 도달했습니다.",409);
 // The coordinator supplies this configured grant; member commands cannot create accounts.
 const initialCredit=integer(p.initialCredit??0,0,1000,"가입 기본 크레딧");
 b.accounts[p.account]=initialCredit;b.issued+=initialCredit;
 if(initialCredit)b.ledger.push({id:id(),type:"grant",reason:"signup",at:now,amount:initialCredit,to:p.account,note:"가입 기본 크레딧 · 계정당 1회 지급"});
 return {account:p.account,created:true,initialCredit,balance:initialCredit};
 }
 if(action==="allocate"){
 fail(mode==="live"&&isMemberAccount(p.account)&&Object.hasOwn(b.accounts,p.account),"배분할 참여자 계정을 확인하세요.");
 const amount=integer(p.amount,1,1000000,"배분 크레딧");
 fail(available(b,"requester")>=amount,"운영 준비금의 사용 가능한 잔액이 부족합니다.",409);
 b.accounts.requester-=amount;b.accounts[p.account]+=amount;
 const receipt=id();b.ledger.push({id:receipt,type:"allocation",at:now,amount,from:"requester",to:p.account,note:"기존 운영 준비금에서 참여자에게 배분"});
 return {account:p.account,amount,receipt};
 }
 if(action==="archive"){
 const j=jobFor(b,p.jobId);fail(["completed","partial","cancelled"].includes(j.status),"실행 중인 작업은 보관할 수 없습니다.");
 j.archived=true;delete j.messages;for(const d of j.documents){delete d.text;}for(const t of j.tasks){delete t.raw;delete t.items;delete t.output;delete t.messages;}
 return {};
 }
 throw new RelayError("알 수 없는 동작입니다.");
}
export function assertInvariants(s){
 for(const b of Object.values(s.books)){
 const reserved=reservations(b),receipts=new Map();let settlements=0;
 for(const entry of b.ledger){receipts.set(entry.taskId,(receipts.get(entry.taskId)??0)+1);if(entry.type==="settlement")settlements++;}
 for(const account of Object.keys(b.accounts))fail(b.accounts[account]-(reserved.get(account)??0)>=0,"원장 불변식: 음수 가용 잔액",500);
 fail(Object.values(b.accounts).every(Number.isSafeInteger),"정수 크레딧 불변식",500);
 fail(Object.values(b.accounts).reduce((a,c)=>a+c,0)===b.issued,"원장 보존식 위반",500);
 const settled=new Set();const slots=new Set();
 for(const j of b.jobs){fail(j.spent+j.reserved<=j.budget,"작업 예산 불변식",500);
 for(const t of j.tasks){if(t.status==="leased"){fail(!slots.has(t.lease.nodeId),"노드 중복 할당",500);slots.add(t.lease.nodeId);}
 if(t.status==="settled"){fail(!settled.has(t.id),"중복 정산",500);settled.add(t.id);fail(receipts.get(t.id)===1,"정산 영수증 불변식",500);}
 }}
 fail(settlements===settled.size,"원장/작업 불일치",500);
 }
}
export function view(s,now=Date.now(),{owned=false}={}){
 // A freshly parsed service state has no other reader; consume it after commit.
 // Direct engine callers still receive an independent snapshot by default.
 const result=owned?{version:s.version,books:s.books}:structuredClone({version:s.version,books:s.books});
 for(const b of Object.values(result.books)){const reserved=reservations(b);b.reserved=reserved.get("requester")??0;b.available=(b.accounts.requester??0)-b.reserved;b.accountAvailable=Object.fromEntries(Object.keys(b.accounts).map(a=>[a,b.accounts[a]-(reserved.get(a)??0)]));b.nodes.forEach(n=>{delete n.tokenHash;n.connected=n.mode==="demo"||n.lastSeen>now-45000;});}
 return result;
}


// Member identities are assigned by the coordinator, never supplied as a payer by a browser.
export const isMemberAccount=account=>typeof account==="string"&&/^member-[a-zA-Z0-9-]{16,80}$/.test(account);
export function memberView(s,account,now=Date.now(),{owned=false}={}){
 const source=s.books.live;fail(isMemberAccount(account)&&Object.hasOwn(source.accounts,account),"참여자 계정을 찾을 수 없습니다.",401);
 const ownJobs=source.jobs.filter(j=>j.payer===account),ownIds=new Set(ownJobs.map(j=>j.id));
 const busy=new Set();
 for(const j of source.jobs){if(j.kind==="rental"&&!j.finishedAt)busy.add(j.allowedNodes[0]);for(const t of j.tasks)if(t.status==="leased")busy.add(t.lease.nodeId);}
 const reserved=outstanding(source,account),spendable=source.accounts[account]-reserved;
 const publicNode=n=>({id:n.id,name:n.name,mode:n.mode,model:n.model,vram:n.vram,context:n.context,status:n.status,lastSeen:n.lastSeen,slots:n.slots,capabilities:n.capabilities??[],...(n.revoked?{revoked:true}:{}),connected:n.lastSeen>0&&n.lastSeen>now-45000,busy:busy.has(n.id),mine:n.account===account});
 const nodes=source.nodes.map(n=>n.account===account?{...publicNode(n),account,earned:n.earned,completed:n.completed,failures:n.failures}:publicNode(n));
 const ledger=source.ledger.filter(l=>l.from===account||l.to===account).map(l=>{
  const entry={...l};if(entry.from!==undefined&&entry.from!==account&&entry.from!=="requester")entry.from="participant";if(entry.to!==account)entry.to="provider";
  if(!ownIds.has(entry.jobId)){delete entry.jobId;delete entry.taskId;}return entry;
 });
 const result={version:s.version,memberAccount:account,books:{live:{mode:"live",accounts:{[account]:source.accounts[account]},jobs:ownJobs,nodes,models:source.models,ledger,events:source.events.filter(e=>ownIds.has(e.jobId)),available:spendable,reserved,accountAvailable:{[account]:spendable}}}};
 return owned?result:structuredClone(result);
}
