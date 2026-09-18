import {initialState,transition,assertInvariants,view,hash,RelayError} from "./engine.mjs";
export async function readState(store,poolId){let row=await store.read(poolId);if(!row){await store.insert(poolId,JSON.stringify(initialState()));row=await store.read(poolId);}return row;}
export async function execute(store,poolId,command,{provider=false,now,clock=()=>Date.now()}={}){
 if(!command||typeof command!=="object"||!["demo","live"].includes(command.mode))throw new RelayError("올바른 요청 형식이 아닙니다.");
 const fingerprint=await hash(JSON.stringify(command));
 const token=!provider&&command.action==="node"?command.payload?.token:null;
 if(!provider&&command.action==="node"&&(typeof token!=="string"||!/^[a-f0-9-]{72}$/.test(token)))throw new RelayError("안전한 제공자 키가 필요합니다.");
 for(let count=0;count<10;count++){
 const currentTime=now??clock();
 const row=provider?await store.read(poolId):await readState(store,poolId);
 if(!row)throw new RelayError("풀을 찾을 수 없습니다.",404);
 const state=JSON.parse(row.state);let nodeId=null;
 if(provider){
 const node=state.books.live.nodes.find(n=>n.id===command.nodeId);
 if(!node||node.revoked||await hash(command.token??"")!==node.tokenHash)throw new RelayError("제공자 인증에 실패했습니다.",401);
 nodeId=node.id;command.mode="live";
 }else{
 if(typeof command.requestId!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(command.requestId))throw new RelayError("요청 식별자가 필요합니다.");
 const receipt=state.receipts.find(r=>r.id===command.requestId);
 if(receipt){if(receipt.fingerprint!==fingerprint)throw new RelayError("같은 요청 식별자를 다른 내용에 사용할 수 없습니다.",409);return {state:view(state,currentTime),result:{...receipt.result,duplicate:true},poolId};}
 }
 const payload={...(command.payload??{})};if(token)payload.tokenHash=await hash(token);
 const result=await transition(state,command.mode,command.action,payload,currentTime,nodeId);
 assertInvariants(state);
 if(!provider&&command.action!=="tick"){state.receipts.push({id:command.requestId,fingerprint,result,at:currentTime});state.receipts=state.receipts.filter(r=>r.at>currentTime-86400000).slice(-512);}
 const serialized=JSON.stringify(state);
 // Reserve room for every outstanding bounded response, so settlement cannot deadlock on size.
 const pending=Object.values(state.books).flatMap(b=>b.jobs).flatMap(j=>j.tasks).filter(t=>["ready","leased"].includes(t.status)).length;
 if(new TextEncoder().encode(serialized).length+pending*64000>1700000)throw new RelayError("풀 저장 한도에 가까워졌습니다. 완료 결과를 내보낸 뒤 보관하세요.",409);
 if(await store.compareAndSwap(poolId,row.revision,serialized)){
 return provider?{result}:{state:view(state,currentTime),poolId,result:{...result,...(token?{token}: {})}};
 }
 }
 throw new RelayError("동시 요청이 많습니다. 잠시 후 다시 시도하세요.",409);
}
export async function getView(store,poolId){const row=await readState(store,poolId);return {state:view(JSON.parse(row.state)),poolId};}
export function errorResponse(error){const status=error instanceof RelayError?error.status:503;if(status===503)console.error("Relay storage unavailable",error);return Response.json({error:status===503?"저장소에 연결하지 못했습니다. 입력을 유지한 채 다시 시도하세요.":error.message},{status,headers:{"Cache-Control":"no-store"}});}
export async function readBody(request){
 const n=Number(request.headers.get("content-length")??0);if(n>90000)throw new RelayError("요청 크기 제한을 초과했습니다.",413);
 const reader=request.body?.getReader();if(!reader)throw new RelayError("요청 본문이 없습니다.");
 let size=0,parts=[];for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>90000){await reader.cancel();throw new RelayError("요청 크기 제한을 초과했습니다.",413);}parts.push(value);}
 const all=new Uint8Array(size);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.length;}
 try{return JSON.parse(new TextDecoder().decode(all));}catch{throw new RelayError("JSON 요청 형식을 확인하세요.");}
}

