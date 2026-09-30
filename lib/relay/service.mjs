import {Buffer} from "node:buffer";
import {initialState,transition,assertInvariants,view,memberView,isMemberAccount,hash,RelayError} from "./engine.mjs";
const isObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
export async function readState(store,poolId){let row=await store.read(poolId);if(!row){await store.insert(poolId,JSON.stringify(initialState()));row=await store.read(poolId);}return row;}
export async function execute(store,poolId,command,options={}){
 const run=()=>{options.signal?.throwIfAborted();return executeCommand(store,poolId,command,options);};
 return store.runCommand?store.runCommand(run):run();
}
async function executeCommand(store,poolId,command,{provider=false,now,clock=()=>Date.now(),nodeTokenHash,memberAccount,ownerAccount,modelArtifact}={}){
 if(!isObject(command)||!["demo","live"].includes(command.mode))throw new RelayError("올바른 요청 형식이 아닙니다.");
 if(Object.hasOwn(command,"payload")&&!isObject(command.payload))throw new RelayError("동작 입력은 JSON 객체여야 합니다.");
 // Only trusted server code may supply an already-hashed participant credential.
 // HTTP command payloads never become execute options.
 if(nodeTokenHash!==undefined&&(provider||command.action!=="node"||typeof nodeTokenHash!=="string"||!/^[a-f0-9]{64}$/.test(nodeTokenHash)||command.payload?.token!==undefined))throw new RelayError("참여자 키 등록 형식이 올바르지 않습니다.");
 if(memberAccount!==undefined&&(provider||command.mode!=="live"||!isMemberAccount(memberAccount)||!["create","chat","rent","reset-chat","retry","cancel","archive","pause","resume","revoke","tick"].includes(command.action)))throw new RelayError("허용되지 않은 참여자 동작입니다.",403);
 if(ownerAccount!==undefined&&(provider||memberAccount!==undefined||command.action!=="node"||!isMemberAccount(ownerAccount)))throw new RelayError("GPU 소유자 계정 형식이 올바르지 않습니다.");
 if(modelArtifact!==undefined&&(provider||!["chat","rent"].includes(command.action)||!isObject(modelArtifact)||typeof modelArtifact.id!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(modelArtifact.id)||typeof modelArtifact.digest!=="string"||!/^[a-f0-9]{64}$/.test(modelArtifact.digest)||typeof modelArtifact.name!=="string"||!modelArtifact.name.trim()||modelArtifact.name.length>240||!Number.isSafeInteger(modelArtifact.size)||modelArtifact.size<1||command.payload?.artifactId!==modelArtifact.id))throw new RelayError("업로드한 모델 정보를 확인하세요.",403);
 if(["chat","rent"].includes(command.action)&&command.payload?.artifactId!==undefined&&modelArtifact===undefined)throw new RelayError("업로드한 모델의 소유권을 확인할 수 없습니다.",403);
 const trusted={...(nodeTokenHash!==undefined?{nodeTokenHash}:{}),...(memberAccount!==undefined?{memberAccount}:{}),...(ownerAccount!==undefined?{ownerAccount}:{}),...(modelArtifact!==undefined?{modelArtifact}: {})};
 const fingerprint=provider?null:await hash(JSON.stringify(Object.keys(trusted).length?{command,...trusted}:command));
 const output=(state,time)=>memberAccount===undefined?view(state,time,{owned:true}):memberView(state,memberAccount,time,{owned:true});
 const token=!provider&&command.action==="node"?command.payload?.token:null;
 if(!provider&&command.action==="node"&&nodeTokenHash===undefined&&(typeof token!=="string"||!/^[a-f0-9-]{72}$/.test(token)))throw new RelayError("안전한 제공자 키가 필요합니다.");
 for(let count=0;count<10;count++){
 const currentTime=now??clock();
 const row=provider?await store.read(poolId):await readState(store,poolId);
 if(!row)throw new RelayError("풀을 찾을 수 없습니다.",404);
 const state=JSON.parse(row.state);let nodeId=null;
 if(memberAccount!==undefined){
 const b=state.books.live;if(!Object.hasOwn(b.accounts,memberAccount))throw new RelayError("참여자 계정을 찾을 수 없습니다.",401);
 if(["retry","cancel","archive"].includes(command.action)&&!b.jobs.some(j=>j.id===command.payload?.jobId&&j.payer===memberAccount))throw new RelayError("내 작업을 찾을 수 없습니다.",404);
 if((command.action==="reset-chat"||command.action==="chat"&&command.payload?.rentalId!==undefined)&&!b.jobs.some(j=>j.id===command.payload?.rentalId&&j.kind==="rental"&&j.payer===memberAccount))throw new RelayError("내 GPU 대여를 찾을 수 없습니다.",404);
 if(["pause","resume","revoke"].includes(command.action)&&!b.nodes.some(n=>n.id===command.payload?.nodeId&&n.account===memberAccount))throw new RelayError("내 GPU를 찾을 수 없습니다.",404);
 }
 if(provider){
 const node=state.books.live.nodes.find(n=>n.id===command.nodeId);
 if(!node||node.revoked||await hash(command.token??"")!==node.tokenHash)throw new RelayError("제공자 인증에 실패했습니다.",401);
 nodeId=node.id;command.mode="live";
 }else{
 if(typeof command.requestId!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(command.requestId))throw new RelayError("요청 식별자가 필요합니다.");
 const receipt=state.receipts.find(r=>r.id===command.requestId);
 if(receipt){if(receipt.fingerprint!==fingerprint)throw new RelayError("같은 요청 식별자를 다른 내용에 사용할 수 없습니다.",409);return {state:output(state,currentTime),result:{...receipt.result,duplicate:true},poolId};}
 }
 const payload={...(command.payload??{})};
 if(modelArtifact!==undefined){
  if(!Array.isArray(payload.allowedNodes)||payload.allowedNodes.length!==1)throw new RelayError("모델을 올릴 GPU 한 대를 선택하세요.");
  const node=state.books.live.nodes.find(node=>node.id===payload.allowedNodes[0]&&!node.revoked);
  if(!node)throw new RelayError("선택한 GPU를 찾을 수 없습니다.",404);
  payload.modelId=node.model;
 }
 if(memberAccount!==undefined&&(["create","rent"].includes(command.action)||command.action==="chat"&&payload.rentalId===undefined)){
  payload.payer=memberAccount;
  const offers=state.books.live.nodes.filter(n=>n.account!==memberAccount&&!n.revoked&&n.model===payload.modelId&&(command.action==="rent"?n.capabilities?.includes("rental-session"):command.action!=="chat"||n.capabilities?.includes(modelArtifact!==undefined?"renter-model":"chat")));
  if(payload.allowedNodes!==undefined&&!Array.isArray(payload.allowedNodes))throw new RelayError("허용 GPU 목록은 배열이어야 합니다.");
  if(!payload.allowedNodes?.length)payload.allowedNodes=offers.map(n=>n.id);
  if(!payload.allowedNodes.length||!payload.allowedNodes.every(id=>offers.some(n=>n.id===id)))throw new RelayError("선택한 모델을 제공하는 다른 참여자의 GPU를 선택하세요.",409);
 }
 if(token)payload.tokenHash=await hash(token);if(nodeTokenHash!==undefined)payload.tokenHash=nodeTokenHash;
 const previousEvent=state.books.live.events[0]?.id;
 const result=await transition(state,command.mode,command.action,payload,currentTime,nodeId,{ownerAccount,modelArtifact});
 assertInvariants(state);
 if(!provider&&command.action!=="tick"){state.receipts.push({id:command.requestId,fingerprint,result,at:currentTime});state.receipts=state.receipts.filter(r=>r.at>currentTime-86400000).slice(-512);}
 const serialized=JSON.stringify(state);
 // Reserve room for every outstanding bounded response, so settlement cannot deadlock on size.
 let pending=0;for(const b of Object.values(state.books))for(const j of b.jobs)for(const t of j.tasks)if(t.status==="ready"||t.status==="leased")pending++;
 if(Buffer.byteLength(serialized)+pending*64000>1700000)throw new RelayError("풀 저장 한도에 가까워졌습니다. 완료 결과를 내보낸 뒤 보관하세요.",409);
 if(await store.compareAndSwap(poolId,row.revision,serialized)){
 // Plain provider heartbeats do not wake idle peers. A sweep/dispatch does;
 // notify only after the state/lease has crossed the durable CAS boundary.
 if(command.mode==="live"&&(!provider||state.books.live.events[0]?.id!==previousEvent))store.notify?.(poolId);
 return provider?{result}:{state:output(state,currentTime),poolId,result:{...result,...(token?{token}: {})}};
 }
 }
 throw new RelayError("동시 요청이 많습니다. 잠시 후 다시 시도하세요.",409);
}
export async function getView(store,poolId){const row=await readState(store,poolId);return {state:view(JSON.parse(row.state),Date.now(),{owned:true}),poolId};}
export async function getMemberView(store,poolId,memberAccount){const row=await readState(store,poolId);return {state:memberView(JSON.parse(row.state),memberAccount,Date.now(),{owned:true}),poolId};}
export function errorResponse(error){const known=error instanceof RelayError;const status=known?error.status:503;if(!known)console.error("Relay storage unavailable",error);return Response.json({error:known?error.message:"저장소에 연결하지 못했습니다. 입력을 유지한 채 다시 시도하세요."},{status,headers:{"Cache-Control":"no-store"}});}
export async function readBody(request){
 const n=Number(request.headers.get("content-length")??0);if(n>90000)throw new RelayError("요청 크기 제한을 초과했습니다.",413);
 const reader=request.body?.getReader();if(!reader)throw new RelayError("요청 본문이 없습니다.");
 let size=0,parts=[];for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>90000){await reader.cancel();throw new RelayError("요청 크기 제한을 초과했습니다.",413);}parts.push(value);}
 const all=parts.length===1?parts[0]:Buffer.concat(parts,size);
 let body;try{body=JSON.parse(new TextDecoder().decode(all));}catch{throw new RelayError("JSON 요청 형식을 확인하세요.");}
 if(!isObject(body))throw new RelayError("요청 본문은 JSON 객체여야 합니다.");
 return body;
}

