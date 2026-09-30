import http from "node:http";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {createGzip,createBrotliCompress,constants as zlib} from "node:zlib";
import {DatabaseSync} from "node:sqlite";
import {readFile,stat,mkdir,writeFile,open} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve,dirname,extname,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes,timingSafeEqual} from "node:crypto";
import {execute,getView,errorResponse,readBody} from "../lib/relay/service.mjs";
import {RelayError} from "../lib/relay/engine.mjs";
import {createMaintenanceScheduler} from "./maintenance.mjs";
import {createLaunchTicket,directLaunchRequest,isLoopback,loopbackOrigin,validatedPublicOrigin} from "./launch-auth.mjs";
import {providerArchive} from "./provider-archive.mjs";
import {createInferenceGateway} from "../lib/relay/inference.mjs";
import {createParticipation} from "./participation.mjs";
import {createModelArtifacts} from "./model-artifacts.mjs";
import {clientAddress} from "./client-address.mjs";
import {createProviderPollHub} from "./provider-poll.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const dataDir=resolve(process.env.RELAY_DATA_DIR??resolve(root,".relay"));
await mkdir(dataDir,{recursive:true});
let admin=process.env.RELAY_ADMIN_TOKEN;
if(!admin){const f=resolve(dataDir,"admin-key.txt");if(existsSync(f))admin=(await readFile(f,"utf8")).trim();else{admin=randomBytes(32).toString("hex");await writeFile(f,admin,{mode:0o600});}console.log("Administrator key file: "+f);}
if(admin.length<32)throw Error("RELAY_ADMIN_TOKEN must contain at least 32 characters.");
let inferenceConfig;
if(process.env.RELAY_INFERENCE_CONFIG){
 const path=resolve(process.env.RELAY_INFERENCE_CONFIG);
 if((await stat(path)).size>262144)throw Error("Inference configuration exceeds 256 KiB.");
 inferenceConfig=JSON.parse((await readFile(path,"utf8")).replace(/^\uFEFF/,""));
}
const sessions=new Map();const rates=new Map();const secure=process.env.RELAY_SECURE_COOKIE==="1";
const publicOrigin=validatedPublicOrigin(process.env.RELAY_PUBLIC_ORIGIN);
const listenHost=process.env.RELAY_HOST??"127.0.0.1";
const trustProxy=process.env.RELAY_TRUST_PROXY==="1";
let localOrigin=null,launchTicket=null;
function sessionResponse(){
 for(const[k,v]of sessions)if(v<Date.now())sessions.delete(k);
 const key=randomBytes(32).toString("hex");sessions.set(key,Date.now()+43200000);
 return Response.json({ok:true},{headers:{"Set-Cookie":"relay_session="+key+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200"+(secure?"; Secure":"")}});
}
const db=new DatabaseSync(resolve(dataDir,"relay.sqlite"));db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS relay_workspaces(id TEXT PRIMARY KEY NOT NULL,state TEXT NOT NULL)");
db.exec("CREATE TABLE IF NOT EXISTS relay_inference_providers(gpuId TEXT PRIMARY KEY NOT NULL,state TEXT NOT NULL)");
const inference=createInferenceGateway(inferenceConfig,{workspaceStore:{
 load:()=>db.prepare("SELECT state FROM relay_workspaces ORDER BY rowid LIMIT 257").all().map(row=>JSON.parse(row.state)),
 save:space=>db.prepare("INSERT INTO relay_workspaces(id,state) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(space.id,JSON.stringify(space)),
},providerStateStore:{
 load:()=>db.prepare("SELECT state FROM relay_inference_providers").all().map(row=>JSON.parse(row.state)),
 save:state=>db.prepare("INSERT INTO relay_inference_providers(gpuId,state) VALUES (?,?) ON CONFLICT(gpuId) DO UPDATE SET state=excluded.state").run(state.gpuId,JSON.stringify(state)),
}});
db.exec("CREATE TABLE IF NOT EXISTS relay_pools(id TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL)");
const poolRead=db.prepare("SELECT revision,state FROM relay_pools WHERE id=?"),poolInsert=db.prepare("INSERT OR IGNORE INTO relay_pools(id,revision,state) VALUES (?,0,?)"),poolSwap=db.prepare("UPDATE relay_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?"),poolList=db.prepare("SELECT id FROM relay_pools WHERE id>? ORDER BY id LIMIT ?");
const providerPoll=createProviderPollHub();
let commandTail=Promise.resolve();
// ponytail: one local pool. Queue short state transactions, never HTTP waits or
// inference; retain CAS for external writers. Split by pool if that scope grows.
const runCommand=operation=>{
 const result=commandTail.then(()=>{if(shuttingDown)throw new RelayError("서버가 종료 중입니다.",503);return operation();});
 commandTail=result.then(()=>{},()=>{});return result;
};
const store={read:async(id)=>poolRead.get(id),insert:async(id,state)=>poolInsert.run(id,state),compareAndSwap:async(id,revision,state)=>poolSwap.run(state,id,revision).changes===1,notify:providerPoll.notify,runCommand};
const maintenanceMs=Number(process.env.RELAY_MAINTENANCE_MS??1000);
if(!Number.isInteger(maintenanceMs)||maintenanceMs<250||maintenanceMs>60000)throw Error("RELAY_MAINTENANCE_MS must be between 250 and 60000.");
const maintenance=createMaintenanceScheduler({
 store,
 listPoolIds:async(after,limit)=>poolList.all(after??"",limit).map(row=>row.id),
 intervalMs:maintenanceMs,
 maxPoolsPerRun:16,
 onError:(error,{poolId})=>console.error("Relay background maintenance failed:",poolId??"pool-list",error.name),
});
const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
function snapshotEncoding(value=""){
 const weights={};
 for(const field of value.split(",")){
  const match=field.trim().match(/^(br|gzip|identity|\*)(?:\s*;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i);
  if(match){const key=match[1].toLowerCase(),weight=match[2]===undefined?1:Number(match[2]);weights[key]=Math.min(weights[key]??1,weight);}
 }
 const br=weights.br??weights["*"]??0,gzip=weights.gzip??weights["*"]??0;
 if(br>0&&br>=gzip&&br>=(weights.identity??0))return "br";
 if(gzip>0&&gzip>=(weights.identity??0))return "gzip";
 return (weights.identity??(weights["*"]===0?0:1))>0?"identity":null;
}
function identity(req){const cookie=req.headers.get("cookie")??"";const key=cookie.match(/(?:^|; )relay_session=([a-f0-9]+)/)?.[1];const expiration=sessions.get(key);if(!expiration||expiration<Date.now())throw new RelayError("로그인이 필요합니다.",401);return "local-owner";}
function limit(key,max=160){const now=Date.now();if(rates.size>2000)for(const [k,v]of rates)if(v.until<now)rates.delete(k);let v=rates.get(key);if(!v||v.until<now){v={count:0,until:now+60000};if(rates.size>=2000)rates.delete(rates.keys().next().value);rates.set(key,v);}if(++v.count>max)throw new RelayError("요청이 너무 많습니다. 잠시 후 다시 시도하세요.",429);}
const artifacts=createModelArtifacts({db,dataDir,store});
const participation=createParticipation({db,store,root,identity,limit,artifacts,coordinator:()=>publicOrigin??localOrigin,signupCredits:Number(process.env.RELAY_SIGNUP_CREDITS??100)});
async function handler(request,ip){
 const url=new URL(request.url);const route=url.pathname;
 if(["POST","DELETE"].includes(request.method)){const origin=request.headers.get("origin");if(origin&&origin!==url.origin&&origin!==publicOrigin)throw new RelayError("허용되지 않은 요청 출처입니다.",403);}
 const participationResponse=await participation(request,ip);if(participationResponse)return participationResponse;
 if(route.startsWith("/api/provider/models/")&&request.method==="GET"){
  limit("model-download:"+ip,120);
  return artifacts.download(request,route.slice("/api/provider/models/".length));
 }
 if(route==="/api/launch-login"&&request.method==="POST"){
 limit("launch:"+ip,12);
 if(!launchTicket||!directLaunchRequest(request,ip,localOrigin))throw new RelayError("이 컴퓨터에서 실행한 설정 창에서 다시 시도하세요.",403);
 const body=await readBody(request);
 if(!launchTicket.consume(body.token))throw new RelayError("자동 로그인 링크가 만료되었거나 이미 사용되었습니다. 실행기를 다시 열거나 관리자 키로 로그인하세요.",401);
 return sessionResponse();
 }
 if(route==="/api/setup"&&request.method==="GET"){
 identity(request);const coordinator=publicOrigin??localOrigin;
 return Response.json({coordinator,localOnly:isLoopback(new URL(coordinator).hostname)});
 }
 if(route==="/api/setup/provider.zip"&&request.method==="GET"){
 identity(request);
 try{return new Response(await providerArchive(root,{coordinator:publicOrigin??localOrigin}),{headers:{"Content-Type":"application/zip","Content-Disposition":"attachment; filename=Relay-Provider.zip"}});}
 catch{throw new RelayError("제공자 설치 파일이 누락되었습니다. 전체 Relay 배포 폴더에서 다시 실행하세요.",503);}
 }
 if(route==="/api/login"&&request.method==="POST"){
 limit("login:"+ip,12);const body=await readBody(request);if(typeof body.token!=="string"||!safeEqual(body.token,admin))throw new RelayError("관리자 키를 확인하세요.",401);
 return sessionResponse();
 }
 if(route==="/api/logout"&&request.method==="POST"){const cookie=request.headers.get("cookie")??"";sessions.delete(cookie.match(/relay_session=([a-f0-9]+)/)?.[1]);return Response.json({ok:true},{headers:{"Set-Cookie":"relay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"}});}
 if(route==="/api/relay"){limit("admin:"+ip);const owner=identity(request);if(request.method==="GET")return Response.json(await getView(store,owner));if(request.method==="POST")return Response.json(await execute(store,owner,await readBody(request)));}
 if(route==="/api/provider"&&request.method==="POST"){
  const body=await readBody(request);if(typeof body.nodeId!=="string"||body.nodeId.length>80)throw new RelayError("노드 형식을 확인하세요.");
  limit("provider-ip:"+ip,1200);limit("provider:"+ip+":"+body.nodeId,80);
  const token=request.headers.get("authorization")?.replace(/^Bearer /,"");
  if(!token||body.poolId!=="local-owner")throw new RelayError("제공자 인증이 필요합니다.",401);
  const waitMs=body.waitMs===undefined?0:body.waitMs,payload=body.payload??{};
  if(body.waitMs!==undefined&&(!Number.isInteger(waitMs)||waitMs<0||waitMs>10000||body.action!=="poll"||
    ["attemptId","epoch","rentalId"].some(key=>Object.hasOwn(payload,key))))throw new RelayError("작업 대기는 새 작업 poll에만 0~10000ms로 설정할 수 있습니다.");
  const deadline=performance.now()+waitMs;
  for(;;){
   request.signal.throwIfAborted();
   const observed=providerPoll.version(body.poolId);
   const response=await execute(store,body.poolId,{...body,mode:"live",token},{provider:true,signal:request.signal});
   request.signal.throwIfAborted();
   if(!waitMs||response.result.task||response.result.rental||response.result.paused||performance.now()>=deadline)
    return Response.json(waitMs?{...response,result:{...response.result,waitSupported:true}}:response);
   await providerPoll.wait(body.poolId,body.nodeId,observed,deadline-performance.now(),request.signal);
  }
 }
 if(route==="/api/inference"&&request.method==="GET"){identity(request);return Response.json(inference.snapshot());}
 if(route==="/api/inference/provider"&&request.method==="POST"){
  if(!isLoopback(ip)&&(!secure||!publicOrigin?.startsWith("https:")))throw new RelayError("원격 GPU 상태 알림에는 HTTPS 공개 주소가 필요합니다.",403);
  limit("inference-provider:"+ip,240);
  return Response.json(inference.providerEvent(request.headers.get("authorization"),await readBody(request)));
 }
 const adminSpace=route.match(/^\/api\/inference\/workspaces(?:\/([a-zA-Z0-9_-]{1,80})(\/chat)?)?$/);
 if(adminSpace){
  identity(request);limit("inference-admin:"+ip,120);
  const [,id,chat]=adminSpace;
  if(!id&&request.method==="GET")return Response.json(inference.workspaceSnapshot(inference.operator));
  if(!id&&request.method==="POST")return Response.json(await inference.createWorkspace(inference.operator,await readBody(request),request.signal),{status:201});
  if(id&&!chat&&request.method==="DELETE")return Response.json(await inference.stopWorkspace(inference.operator,id));
  if(id&&chat&&request.method==="POST")return inference.completeWorkspace(inference.operator,id,await readBody(request),request.signal,request.headers.get("idempotency-key"));
  throw new RelayError("허용되지 않은 요청입니다.",405);
 }
 if(route==="/api/inference/chat"&&request.method==="POST"){
  identity(request);limit("inference-admin:"+ip,120);
  return inference.complete(inference.operator,await readBody(request),request.signal,request.headers.get("idempotency-key"));
 }
 const tenantSpace=route.match(/^\/v1\/workspaces(?:\/([a-zA-Z0-9_-]{1,80})(\/chat\/completions)?)?$/);
 if(route==="/v1/models"||route==="/v1/chat/completions"||tenantSpace){
  if(!isLoopback(ip)&&(!secure||!publicOrigin?.startsWith("https:")))throw new RelayError("원격 추론은 HTTPS 공개 주소와 secure cookie 설정이 필요합니다.",403);
  limit("inference-ip:"+ip,240);
  const tenant=inference.authenticate(request.headers.get("authorization"),tenantSpace?.[1]);
  limit("inference-tenant:"+tenant.id,120);
  if(route==="/v1/models"&&request.method==="GET")return Response.json(inference.models(tenant));
  if(route==="/v1/chat/completions"&&request.method==="POST")return inference.complete(tenant,await readBody(request),request.signal,request.headers.get("idempotency-key"));
  if(tenantSpace){
   const [,id,chat]=tenantSpace;
   if(!id&&request.method==="GET")return Response.json(inference.workspaceSnapshot(tenant));
   if(!id&&request.method==="POST")return Response.json(await inference.createWorkspace(tenant,await readBody(request),request.signal),{status:201});
   if(id&&!chat&&request.method==="DELETE")return Response.json(await inference.stopWorkspace(tenant,id));
   if(id&&chat&&request.method==="POST")return inference.completeWorkspace(tenant,id,await readBody(request),request.signal,request.headers.get("idempotency-key"));
  }
  throw new RelayError("허용되지 않은 요청입니다.",405);
 }
 if(route.startsWith("/api/"))throw new RelayError("API를 찾을 수 없습니다.",404);
 if(request.method!=="GET")throw new RelayError("허용되지 않은 요청입니다.",405);

 const publicRoot=resolve(root,process.env.RELAY_WEB_ROOT??"standalone-dist");let pathname;try{pathname=decodeURIComponent(route);}catch{throw new RelayError("잘못된 경로입니다.",400);}
 const target=resolve(publicRoot,"."+pathname+(pathname==="/"?"index.html":""));const rel=relative(publicRoot,target);if(rel.startsWith("..")||rel.includes(":"))throw new RelayError("잘못된 경로입니다.",400);
 let file;
 try{
  file=await open(target,"r");const info=await file.stat();if(!info.isFile())throw Error();
  const type={".html":"text/html;charset=utf-8",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".woff2":"font/woff2",".py":"text/plain;charset=utf-8"}[extname(target)]??"application/octet-stream";
  const immutable=/^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(pathname);
  const etag=`W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  const headers={"Content-Type":type,"Cache-Control":immutable?"public, max-age=31536000, immutable":"no-cache","ETag":etag};
  if(request.headers.get("if-none-match")?.split(",").some(value=>value.trim().replace(/^W\//,"")===etag.slice(2)||value.trim()==="*")){await file.close();return new Response(null,{status:304,headers});}
  if(info.size===0){await file.close();return new Response(null,{headers:{...headers,"Content-Length":"0"}});}
  const stream=file.createReadStream({signal:request.signal,end:info.size-1});
  const body=Readable.from((async function*(){
   yield* stream;
   // Early EOF must abort the HTTP frame, never consume the next response.
   if(stream.bytesRead!==info.size)throw Error("Static file changed during transfer.");
  })(),{objectMode:false});
  return new Response(Readable.toWeb(body),{headers:{...headers,"Content-Length":String(info.size)}});
 }catch{await file?.close().catch(()=>{});throw new RelayError("파일을 찾을 수 없습니다. 먼저 standalone 빌드를 실행하세요.",404);}
}
const activeRequests=new Set();
let shuttingDown=false;
async function respond(req,res){
 if(shuttingDown){res.writeHead(503,{"Content-Type":"application/json","Connection":"close"});res.end(JSON.stringify({error:"서버가 종료 중입니다. 잠시 후 다시 시도하세요."}));return;}

 const disconnected=new AbortController();
 const abort=()=>{if(!res.writableEnded)disconnected.abort();};
 res.once("close",abort);
 try{
 const ip=clientAddress(req,trustProxy);
 const host=req.headers.host??"localhost";const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(","):v);
 const route=new URL(req.url,"http://"+host).pathname;
 const upload=req.method==="POST"&&route==="/api/member/models";
 req.setTimeout(upload?60000:15000,()=>req.destroy());
 let body;
 if(upload)body=Readable.toWeb(req);
 else {let chunks=[],length=0;for await(const chunk of req){length+=chunk.length;if(length>90000)throw new RelayError("요청 크기 제한을 초과했습니다.",413);chunks.push(chunk);}if(length)body=chunks.length===1?chunks[0]:Buffer.concat(chunks,length);}
 // Slow prefill is governed by the gateway deadline, not the short input-body
 // inactivity timer. Leave time for the gateway's acknowledged KV cleanup.
 if(route.startsWith("/v1/")||route.startsWith("/api/inference"))req.setTimeout((inferenceConfig?.requestTimeoutMs??600000)+10000);
 const request=new Request("http://"+host+req.url,{method:req.method,headers,signal:disconnected.signal,...(body?{body,duplex:"half"}:{})});
 const response=await handler(request,ip);
 // Only sanitized snapshots: no credential responses, SSE or model bytes.
 const snapshot=req.method==="GET"&&response.status===200&&(route==="/api/relay"||route==="/api/member/me");
 const encoding=snapshot?snapshotEncoding(req.headers["accept-encoding"]):"identity";
 if(encoding===null)throw new RelayError("지원하는 응답 인코딩을 선택하세요.",406);
 if(snapshot)response.headers.append("Vary","Accept-Encoding");
 if(encoding!=="identity"){response.headers.set("Content-Encoding",encoding);response.headers.delete("Content-Length");}
 res.writeHead(response.status,{"x-content-type-options":"nosniff","x-frame-options":"DENY","referrer-policy":"no-referrer","cache-control":"no-store","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",...Object.fromEntries(response.headers)});
 if(response.body){
  // pipeline consumes Web streams directly; an adapter adds a prefetched chunk.
  const source=response.body;
  if(encoding==="br")await pipeline(source,createBrotliCompress({params:{[zlib.BROTLI_PARAM_QUALITY]:1,[zlib.BROTLI_PARAM_LGWIN]:16}}),res);
  else if(encoding==="gzip")await pipeline(source,createGzip({level:1,windowBits:13,memLevel:6}),res);
  else await pipeline(source,res);
 }else res.end();
 }catch(e){
  if(res.headersSent||res.destroyed){res.destroy();return;}
  const response=errorResponse(e);res.writeHead(response.status,{"Content-Type":"application/json","Cache-Control":"no-store",...(response.status===429?{"Retry-After":"1"}:{})});res.end(await response.text());
 }finally{res.removeListener("close",abort);}
}
const server=http.createServer((req,res)=>{
 const pending=respond(req,res);activeRequests.add(pending);
 void pending.finally(()=>activeRequests.delete(pending)).catch(error=>console.error("Relay request failed:",error.name));
});
// Model uploads stream directly to disk after authentication. Individual sockets
// still have a short inactivity timeout; the uploader enforces a one-hour limit.
server.requestTimeout=3600000;
server.listen(Number(process.env.RELAY_PORT??8788),listenHost,()=>{
 maintenance.start();
 localOrigin=loopbackOrigin(server.address());
 console.log("Relay ready at "+(publicOrigin??localOrigin));
 if(process.connected){
  if(process.env.RELAY_LAUNCH_LOGIN==="1"){
   if(!trustProxy&&isLoopback(listenHost)&&isLoopback(server.address().address)&&!secure&&!publicOrigin)launchTicket=createLaunchTicket();
   process.send({type:"relay:launch-ready",origin:publicOrigin??localOrigin,...(launchTicket?{token:launchTicket.token}:{})});
  }
  process.send("relay:ready");
 }
});
let shutdown=null;
function stop(){
 if(shutdown)return shutdown;
 shuttingDown=true;
 providerPoll.close();
 inference.close();
 const maintenanceStopped=maintenance.stop();
 const httpStopped=new Promise(resolve=>server.close(resolve));
 server.closeIdleConnections();
 const forceClose=setTimeout(()=>server.closeAllConnections(),15000);forceClose.unref();
 shutdown=Promise.all([maintenanceStopped,httpStopped]).then(async()=>{
  await Promise.allSettled([...activeRequests]);
  clearTimeout(forceClose);db.close();process.exit(0);
 }).catch(error=>{clearTimeout(forceClose);console.error("Relay shutdown failed:",error.name);process.exit(1);});
 return shutdown;
}
process.on("SIGINT",stop);process.on("SIGTERM",stop);
process.on("message",message=>{if(message==="relay:shutdown")void stop();});
