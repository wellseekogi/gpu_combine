import http from "node:http";
import {DatabaseSync} from "node:sqlite";
import {readFile,stat,mkdir,writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {resolve,dirname,extname,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes,timingSafeEqual} from "node:crypto";
import {execute,getView,errorResponse,readBody} from "../lib/relay/service.mjs";
import {RelayError} from "../lib/relay/engine.mjs";
import {createMaintenanceScheduler} from "./maintenance.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const dataDir=resolve(process.env.RELAY_DATA_DIR??resolve(root,".relay"));
await mkdir(dataDir,{recursive:true});
let admin=process.env.RELAY_ADMIN_TOKEN;
if(!admin){const f=resolve(dataDir,"admin-key.txt");if(existsSync(f))admin=(await readFile(f,"utf8")).trim();else{admin=randomBytes(32).toString("hex");await writeFile(f,admin,{mode:0o600});}console.log("Administrator key file: "+f);}
if(admin.length<32)throw Error("RELAY_ADMIN_TOKEN must contain at least 32 characters.");
const sessions=new Map();const rates=new Map();const secure=process.env.RELAY_SECURE_COOKIE==="1";
const db=new DatabaseSync(resolve(dataDir,"relay.sqlite"));db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS relay_pools(id TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL)");
const store={read:async(id)=>db.prepare("SELECT revision,state FROM relay_pools WHERE id=?").get(id),insert:async(id,state)=>db.prepare("INSERT OR IGNORE INTO relay_pools(id,revision,state) VALUES (?,0,?)").run(id,state),compareAndSwap:async(id,revision,state)=>db.prepare("UPDATE relay_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?").run(state,id,revision).changes===1};
const maintenanceMs=Number(process.env.RELAY_MAINTENANCE_MS??1000);
if(!Number.isInteger(maintenanceMs)||maintenanceMs<250||maintenanceMs>60000)throw Error("RELAY_MAINTENANCE_MS must be between 250 and 60000.");
const maintenance=createMaintenanceScheduler({
 store,
 listPoolIds:async(after,limit)=>db.prepare("SELECT id FROM relay_pools WHERE id>? ORDER BY id LIMIT ?").all(after??"",limit).map(row=>row.id),
 intervalMs:maintenanceMs,
 maxPoolsPerRun:16,
 onError:(error,{poolId})=>console.error("Relay background maintenance failed:",poolId??"pool-list",error.name),
});
const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
function identity(req){const cookie=req.headers.get("cookie")??"";const key=cookie.match(/(?:^|; )relay_session=([a-f0-9]+)/)?.[1];const expiration=sessions.get(key);if(!expiration||expiration<Date.now())throw new RelayError("로그인이 필요합니다.",401);return "local-owner";}
function limit(key,max=160){const now=Date.now();if(rates.size>2000)for(const [k,v]of rates)if(v.until<now)rates.delete(k);let v=rates.get(key);if(!v||v.until<now){v={count:0,until:now+60000};if(rates.size>=2000)rates.delete(rates.keys().next().value);rates.set(key,v);}if(++v.count>max)throw new RelayError("요청이 너무 많습니다. 잠시 후 다시 시도하세요.",429);}
async function handler(request,ip){
 const url=new URL(request.url);const route=url.pathname;
 if(request.method==="POST"){const origin=request.headers.get("origin");if(origin&&origin!==url.origin&&origin!==process.env.RELAY_PUBLIC_ORIGIN)throw new RelayError("허용되지 않은 요청 출처입니다.",403);}
 if(route==="/api/login"&&request.method==="POST"){
 limit("login:"+ip,12);const body=await readBody(request);if(typeof body.token!=="string"||!safeEqual(body.token,admin))throw new RelayError("관리자 키를 확인하세요.",401);
 for(const[k,v]of sessions)if(v<Date.now())sessions.delete(k);
 const key=randomBytes(32).toString("hex");sessions.set(key,Date.now()+43200000);
 return Response.json({ok:true},{headers:{"Set-Cookie":"relay_session="+key+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200"+(secure?"; Secure":"")}});
 }
 if(route==="/api/logout"&&request.method==="POST"){const cookie=request.headers.get("cookie")??"";sessions.delete(cookie.match(/relay_session=([a-f0-9]+)/)?.[1]);return Response.json({ok:true},{headers:{"Set-Cookie":"relay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"}});}
 if(route==="/api/relay"){limit("admin:"+ip);const owner=identity(request);if(request.method==="GET")return Response.json(await getView(store,owner));if(request.method==="POST")return Response.json(await execute(store,owner,await readBody(request)));}
 if(route==="/api/provider"&&request.method==="POST"){const body=await readBody(request);if(typeof body.nodeId!=="string"||body.nodeId.length>80)throw new RelayError("노드 형식을 확인하세요.");limit("provider-ip:"+ip,1200);limit("provider:"+ip+":"+body.nodeId,80);const token=request.headers.get("authorization")?.replace(/^Bearer /,"");if(!token||body.poolId!=="local-owner")throw new RelayError("제공자 인증이 필요합니다.",401);return Response.json(await execute(store,body.poolId,{...body,mode:"live",token},{provider:true}));}
 if(route.startsWith("/api/"))throw new RelayError("API를 찾을 수 없습니다.",404);
 if(request.method!=="GET")throw new RelayError("허용되지 않은 요청입니다.",405);

 const publicRoot=resolve(root,"standalone-dist");let pathname;try{pathname=decodeURIComponent(route);}catch{throw new RelayError("잘못된 경로입니다.",400);}
 const target=resolve(publicRoot,"."+pathname+(pathname==="/"?"index.html":""));const rel=relative(publicRoot,target);if(rel.startsWith("..")||rel.includes(":"))throw new RelayError("잘못된 경로입니다.",400);
 try{if(!(await stat(target)).isFile())throw Error();const data=await readFile(target);const type={".html":"text/html;charset=utf-8",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".woff2":"font/woff2",".py":"text/plain;charset=utf-8"}[extname(target)]??"application/octet-stream";return new Response(data,{headers:{"Content-Type":type}});}catch{throw new RelayError("파일을 찾을 수 없습니다. 먼저 standalone 빌드를 실행하세요.",404);}
}
const activeRequests=new Set();
let shuttingDown=false;
async function respond(req,res){
 if(shuttingDown){res.writeHead(503,{"Content-Type":"application/json","Connection":"close"});res.end(JSON.stringify({error:"서버가 종료 중입니다. 잠시 후 다시 시도하세요."}));return;}

 try{
 const host=req.headers.host??"localhost";const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(","):v);
 let chunks=[],length=0;for await(const chunk of req){length+=chunk.length;if(length>90000)throw new RelayError("요청 크기 제한을 초과했습니다.",413);chunks.push(chunk);}
 const request=new Request("http://"+host+req.url,{method:req.method,headers,...(length?{body:Buffer.concat(chunks)}:{})});
 const response=await handler(request,req.socket.remoteAddress??"local");
 res.writeHead(response.status,{"X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"no-referrer","Cache-Control":"no-store","Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",...Object.fromEntries(response.headers)});
 res.end(Buffer.from(await response.arrayBuffer()));
 }catch(e){const response=errorResponse(e);res.writeHead(response.status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(await response.text());}
}
const server=http.createServer((req,res)=>{
 const pending=respond(req,res);activeRequests.add(pending);
 void pending.finally(()=>activeRequests.delete(pending)).catch(error=>console.error("Relay request failed:",error.name));
});
server.requestTimeout=15000;
server.listen(Number(process.env.RELAY_PORT??8788),process.env.RELAY_HOST??"127.0.0.1",()=>{
 maintenance.start();
 console.log("Relay ready at http://"+(process.env.RELAY_HOST??"127.0.0.1")+":"+server.address().port);
 if(process.connected)process.send("relay:ready");
});
let shutdown=null;
function stop(){
 if(shutdown)return shutdown;
 shuttingDown=true;
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
