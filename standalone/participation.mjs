import {randomBytes,timingSafeEqual} from "node:crypto";
import {execute,getMemberView,readBody,readState} from "../lib/relay/service.mjs";
import {hash,RelayError,available} from "../lib/relay/engine.mjs";
import {parseModelContract} from "../lib/relay/setup.mjs";
import {isLoopback,validatedPublicOrigin} from "./launch-auth.mjs";
import {providerArchive} from "./provider-archive.mjs";

const POOL="local-owner";
const identifier=/^[a-zA-Z0-9-]{16,80}$/;
const credential=/^[a-f0-9-]{72}$/;
const equalHash=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function text(value,max,label){
 if(typeof value!=="string"||!value.trim()||value.length>max||Array.from(value).some(character=>{const code=character.codePointAt(0);return code<32||(code>=127&&code<=159);}))throw new RelayError(label+" 형식을 확인하세요.");
 return value.trim();
}
function vram(value){if(!Number.isSafeInteger(value)||value<0||value>200000)throw new RelayError("VRAM 범위를 확인하세요.");return value;}
function modelContract(value){try{return parseModelContract(value);}catch(error){throw new RelayError(error.message);}}
function validateIdentifier(value){if(typeof value!=="string"||!identifier.test(value))throw new RelayError("요청 식별자를 확인하세요.");return value;}
function validateToken(token){if(typeof token!=="string"||!credential.test(token))throw new RelayError("회원 또는 PC 연결 키를 확인하세요.",401);}
function sameModel(a,b){return ["digest","runtime","template","context"].every(key=>a[key]===b[key]);}
const memberSummary=member=>({id:member.id,name:member.name,account:member.account});
function stagingStore(current){
 let staged={...current};
 return {snapshot:()=>staged,read:async()=>staged,insert:async()=>{},compareAndSwap:async(_pool,revision,state)=>{if(staged.revision!==revision)return false;staged={state,revision:revision+1};return true;}};
}

// Member identity, PC credentials and native GPU-start consent are independent.
// Store hashes only. The configured one-time signup grant is server-owned.
export function createParticipation({db,store,root,identity,limit,coordinator,artifacts,signupCredits=100,now=()=>Date.now()}){
 if(!Number.isSafeInteger(signupCredits)||signupCredits<0||signupCredits>1000)throw Error("RELAY_SIGNUP_CREDITS must be an integer between 0 and 1000.");
 db.exec(`CREATE TABLE IF NOT EXISTS relay_members (
  id TEXT PRIMARY KEY NOT NULL, tokenHash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  account TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS relay_member_devices (
  memberId TEXT NOT NULL, requestId TEXT NOT NULL, fingerprint TEXT NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE, nodeId TEXT NOT NULL, createdAt INTEGER NOT NULL,
  PRIMARY KEY(memberId,requestId)
 );
 CREATE TABLE IF NOT EXISTS relay_participation (
  id TEXT PRIMARY KEY NOT NULL, tokenHash TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL, name TEXT NOT NULL, modelName TEXT NOT NULL, model TEXT NOT NULL,
  vram INTEGER NOT NULL, createdAt INTEGER NOT NULL, decision TEXT, nodeId TEXT, modelId TEXT
 )`);
 const getMember=id=>db.prepare("SELECT * FROM relay_members WHERE id=?").get(id);
 const getDevice=(memberId,requestId)=>db.prepare("SELECT * FROM relay_member_devices WHERE memberId=? AND requestId=?").get(memberId,requestId);
 // ponytail: in-memory codes assume one relay process; use shared storage if the service is scaled out.
 const pairings=new Map();
 function pairing(code){
  const time=now();
  for(const [key,value] of pairings)if(value.expiresAt<=time)pairings.delete(key);
  return pairings.get(code);
 }
 function createPairing(member){
  pairing();
  if([...pairings.values()].filter(value=>value.memberId===member.id&&!value.nodeId).length>=3)
   throw new RelayError("동시에 대기할 수 있는 PC 연결은 3개입니다.",429);
  let code;
  do{code=randomBytes(16).toString("base64url");}while(pairings.has(code));
  const expiresAt=now()+600000;
  pairings.set(code,{memberId:member.id,expiresAt,attempts:0,busy:false,nodeId:null});
  return {code,expiresAt};
 }
 async function pairDevice(body){
  const code=body.code;
  const current=typeof code==="string"&&/^[A-Za-z0-9_-]{22}$/.test(code)?pairing(code):null;
  if(!current)throw new RelayError("PC 연결 코드가 만료되었거나 올바르지 않습니다.",404);
  if(current.busy)throw new RelayError("PC 연결 코드가 이미 사용 중입니다.",409);
  if(current.nodeId){
   const claimHash=await hash(JSON.stringify(body));
   if(!equalHash(current.claimHash,claimHash))throw new RelayError("PC 연결 코드가 이미 사용되었습니다.",409);
   const registered=await registerDevice(getMember(current.memberId),body);
   return {config:{...registered.config,token:body.token}};
  }
  if(current.attempts>=5)throw new RelayError("PC 연결 시도 한도를 넘었습니다. 새 코드를 만드세요.",429);
  current.busy=true;
  try{
   const claimHash=await hash(JSON.stringify(body));
   const registered=await registerDevice(getMember(current.memberId),body);
   current.nodeId=registered.config.node;
   current.claimHash=claimHash;
   return {config:{...registered.config,token:body.token}};
  }catch(error){
   if(++current.attempts>=5)pairings.delete(code);
   throw error;
  }finally{current.busy=false;}
 }
 function origin(){
  const value=validatedPublicOrigin(coordinator());
  if(!value)throw new RelayError("서버 연결 주소를 준비하고 있습니다.",503);
  return value;
 }
 function sameRegistration(member,tokenHash,name){
  if(!equalHash(member.tokenHash,tokenHash))throw new RelayError("회원 인증 정보를 확인하세요.",401);
  if(member.name!==name)throw new RelayError("같은 회원 식별자로 등록 이름을 변경할 수 없습니다.",409);
  return memberSummary(member);
 }
 async function authenticate(request){
  const id=request.headers.get("x-relay-member"),token=request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  validateToken(token);
  const member=typeof id==="string"&&identifier.test(id)?getMember(id):null;
  if(!member||!equalHash(member.tokenHash,await hash(token)))throw new RelayError("회원 인증 정보를 확인하세요.",401);
  return member;
 }
 async function liveBook(){const row=await store.read(POOL);return row?JSON.parse(row.state).books.live:null;}
 async function authenticatedNode(nodeId,tokenHash){
  const book=await liveBook();
  const node=typeof nodeId==="string"?book?.nodes.find(value=>value.id===nodeId):null;
  if(!node||node.revoked||!equalHash(node.tokenHash,tokenHash))throw new RelayError("PC 연결 키가 올바르지 않거나 폐기되었습니다.",401);
  const model=book.models.find(value=>value.id===node.model);
  if(!model)throw new RelayError("등록 모델을 찾을 수 없습니다.",409);
  return {node,model};
 }
 async function deviceConfig(row,tokenHash){
  const {node,model}=await authenticatedNode(row.nodeId,tokenHash);
  return {config:{version:1,coordinator:origin(),pool:POOL,node:node.id,nodeName:node.name,context:model.context,model:modelContract(model)}};
 }
 function matchingDevice(previous,fingerprint){
  if(previous.fingerprint!==fingerprint)throw new RelayError("같은 요청 식별자를 다른 PC 정보에 사용할 수 없습니다.",409);
  return previous;
 }
 function assertSeparateMemberCredential(tokenHash){
  const pool=db.prepare("SELECT state FROM relay_pools WHERE id=?").get(POOL);
  const live=pool?JSON.parse(pool.state).books.live:null;
  if(db.prepare("SELECT nodeId FROM relay_member_devices WHERE tokenHash=?").get(tokenHash)||live?.nodes.some(node=>equalHash(node.tokenHash,tokenHash)))throw new RelayError("회원 인증 키와 PC 연결 키는 서로 달라야 합니다.");
 }
 async function register(body){
  const id=validateIdentifier(body.id),name=text(body.name,80,"회원 이름");
  validateToken(body.token);
  const tokenHash=await hash(body.token),account="member-"+id;
  const previous=getMember(id);
  if(previous)return sameRegistration(previous,tokenHash,name);
  if(db.prepare("SELECT id FROM relay_members WHERE tokenHash=?").get(tokenHash))throw new RelayError("이미 등록된 회원 키입니다. 저장한 회원 파일을 불러오세요.",409);
  assertSeparateMemberCredential(tokenHash);
  for(let attempt=0;attempt<10;attempt++){
   const replay=getMember(id);if(replay)return sameRegistration(replay,tokenHash,name);
   if(db.prepare("SELECT COUNT(*) AS count FROM relay_members").get().count>=256)throw new RelayError("회원 등록 한도에 도달했습니다.",429);
   const current=await readState(store,POOL),staging=stagingStore(current);
   await execute(staging,POOL,{mode:"live",action:"member-account",payload:{account,initialCredit:signupCredits},requestId:"member-new-"+await hash(id)},{now:now()});
   db.exec("BEGIN IMMEDIATE");
   try{
    const latest=getMember(id);
    if(latest){const result=sameRegistration(latest,tokenHash,name);db.exec("COMMIT");return result;}
    if(db.prepare("SELECT COUNT(*) AS count FROM relay_members").get().count>=256)throw new RelayError("회원 등록 한도에 도달했습니다.",429);
    if(db.prepare("SELECT id FROM relay_members WHERE tokenHash=?").get(tokenHash))throw new RelayError("이미 등록된 회원 키입니다.",409);
    // Serialize cross-role checks with both registrations, including legacy nodes.
    assertSeparateMemberCredential(tokenHash);
    const changed=db.prepare("UPDATE relay_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?").run(staging.snapshot().state,POOL,current.revision).changes;
    if(changed!==1){db.exec("ROLLBACK");continue;}
    db.prepare("INSERT INTO relay_members(id,tokenHash,name,account,createdAt) VALUES (?,?,?,?,?)").run(id,tokenHash,name,account,now());
    db.exec("COMMIT");
    return {id,name,account};
   }catch(error){db.exec("ROLLBACK");throw error;}
  }
  throw new RelayError("동시 요청이 많습니다. 같은 회원 정보로 다시 시도하세요.",409);
 }
 async function registerDevice(member,body){
  const requestId=validateIdentifier(body.requestId);
  validateToken(body.token);
  const input={name:text(body.name,80,"PC 이름"),modelName:text(body.modelName,100,"모델 이름"),model:modelContract(body.model),vram:vram(body.vram)};
  const tokenHash=await hash(body.token);
  if(db.prepare("SELECT id FROM relay_members WHERE tokenHash=?").get(tokenHash))throw new RelayError("회원 인증 키와 PC 연결 키는 서로 달라야 합니다.");
  const fingerprint=await hash(JSON.stringify({...input,tokenHash}));
  const previous=getDevice(member.id,requestId);
  if(previous)return deviceConfig(matchingDevice(previous,fingerprint),tokenHash);
  const commandHash=await hash(member.id+":"+requestId);
  for(let attempt=0;attempt<10;attempt++){
   const current=await readState(store,POOL),staging=stagingStore(current);
   const replay=getDevice(member.id,requestId);if(replay)return deviceConfig(matchingDevice(replay,fingerprint),tokenHash);
   const live=JSON.parse(current.state).books.live;
   if(live.nodes.some(node=>equalHash(node.tokenHash,tokenHash)))throw new RelayError("이미 등록된 PC 연결 키입니다. PC마다 새 연결 키를 사용하세요.",409);
   let model=live.models.find(candidate=>sameModel(candidate,input.model));
   if(model&&input.vram<model.minVram)throw new RelayError("등록된 모델에 필요한 VRAM보다 이 PC의 VRAM이 작습니다.",409);
   if(live.nodes.length>=20)throw new RelayError("이 서버는 최대 20개 PC를 지원합니다.",409);
   if(!model){
    const added=await execute(staging,POOL,{mode:"live",action:"model",payload:{...input.model,name:input.modelName,minVram:0},requestId:"device-model-"+commandHash},{now:now()});
    model=JSON.parse(staging.snapshot().state).books.live.models.find(candidate=>candidate.id===added.result.modelId);
   }
   const added=await execute(staging,POOL,{mode:"live",action:"node",payload:{name:input.name,modelId:model.id,vram:input.vram},requestId:"device-node-"+commandHash},{now:now(),ownerAccount:member.account,nodeTokenHash:tokenHash});
   db.exec("BEGIN IMMEDIATE");
   let registered;
   try{
    const latest=getDevice(member.id,requestId);
    if(latest){matchingDevice(latest,fingerprint);db.exec("COMMIT");return deviceConfig(latest,tokenHash);}
    // The public precheck may have raced with a new member registration.
    if(db.prepare("SELECT id FROM relay_members WHERE tokenHash=?").get(tokenHash))throw new RelayError("회원 인증 키와 PC 연결 키는 서로 달라야 합니다.");
    const changed=db.prepare("UPDATE relay_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?").run(staging.snapshot().state,POOL,current.revision).changes;
    if(changed!==1){db.exec("ROLLBACK");continue;}
    db.prepare("INSERT INTO relay_member_devices(memberId,requestId,fingerprint,tokenHash,nodeId,createdAt) VALUES (?,?,?,?,?,?)").run(member.id,requestId,fingerprint,tokenHash,added.result.nodeId,now());
    registered={nodeId:added.result.nodeId};
    db.exec("COMMIT");
   }catch(error){db.exec("ROLLBACK");throw error;}
   return deviceConfig(registered,tokenHash);
  }
  throw new RelayError("동시 요청이 많습니다. 같은 PC 정보로 다시 시도하세요.",409);
 }
 async function memberView(member){
  const result=await getMemberView(store,POOL,member.account);
  const book=result.state.books.live,balance=book.accounts[member.account]??0,available=book.accountAvailable?.[member.account]??balance;
  return {...memberSummary(member),credits:{balance,available,reserved:balance-available},...result};
 }
 async function offers(){
  const live=await liveBook();
  return {offers:(live?.nodes??[]).filter(node=>!node.revoked&&node.status==="online"&&node.lastSeen>0&&node.lastSeen>now()-45000).map(node=>({id:node.id,name:node.name,modelId:node.model,vram:node.vram,context:node.context,capabilities:node.capabilities??[]}))};
 }
 async function legacyStatus(body){
  validateToken(body.token);
  const row=typeof body.id==="string"&&identifier.test(body.id)?db.prepare("SELECT * FROM relay_participation WHERE id=?").get(body.id):null;
  if(!row||!equalHash(row.tokenHash,await hash(body.token)))throw new RelayError("PC 등록 또는 연결 키를 확인하세요.",401);
  if(row.status!=="approved")return {id:row.id,name:row.name,status:"member-registration-required",message:"운영자 승인은 필요하지 않습니다. 내 GPU 연결하기에서 회원 등록 후 PC를 연결하세요."};
  return {id:row.id,status:"approved",name:row.name,modelName:row.modelName,...await deviceConfig(row,row.tokenHash)};
 }
 return async function participation(request,ip){
  const path=new URL(request.url).pathname;
  if(!path.startsWith("/api/participation/")&&!path.startsWith("/api/member/"))return null;
  if(path==="/api/member/members"||path==="/api/member/allocate"){
   identity(request);limit("member-admin:"+ip,120);
   if(path==="/api/member/members"&&request.method==="GET"){
    const book=await liveBook();
    return Response.json({members:db.prepare("SELECT id,name,account FROM relay_members ORDER BY createdAt,id LIMIT 256").all().map(member=>({...member,balance:book?.accounts[member.account]??0,available:book?available(book,member.account):0}))});
   }
   if(path==="/api/member/allocate"&&request.method==="POST"){
    const body=await readBody(request);
    if(typeof body.account!=="string"||!db.prepare("SELECT id FROM relay_members WHERE account=?").get(body.account))throw new RelayError("등록된 회원을 선택하세요.");
    return Response.json(await execute(store,POOL,{mode:"live",action:"allocate",payload:{account:body.account,amount:body.amount},requestId:body.requestId}));
   }
  }else if(path==="/api/participation/requests"||path.startsWith("/api/participation/requests/")){
   identity(request);
   if(path==="/api/participation/requests"&&request.method==="GET")return Response.json({requests:[]});
   throw new RelayError("운영자 승인 절차를 사용하지 않습니다. 회원은 내 GPU 연결하기에서 PC를 직접 등록합니다.",410);
  }else if(path==="/api/member/register"&&request.method==="POST"){
   limit("member-register:"+ip,12);
   return Response.json(await register(await readBody(request)));
  }else if(path==="/api/member/offers"&&request.method==="GET"){
   limit("member-offers:"+ip,120);return Response.json(await offers());
  }else if(path.startsWith("/api/member/")){
   limit("member-auth:"+ip,240);
   const member=await authenticate(request);
   limit("member:"+member.id,120);
   if(path==="/api/member/me"&&request.method==="GET")return Response.json(await memberView(member));
   if(path==="/api/member/pairings"&&request.method==="POST")return Response.json(createPairing(member));
   const pairingCode=path.match(/^\/api\/member\/pairings\/([A-Za-z0-9_-]{22})$/)?.[1];
   if(pairingCode&&request.method==="GET"){
    const current=pairing(pairingCode);
    if(!current||current.memberId!==member.id)throw new RelayError("PC 연결 코드를 찾을 수 없습니다.",404);
    return Response.json(current.nodeId?{status:"paired",nodeId:current.nodeId}:{status:"pending"});
   }
   if(path==="/api/member/models"){
    if(!artifacts)throw new RelayError("모델 업로드 저장소를 준비하고 있습니다.",503);
    if(request.method==="GET")return Response.json(await artifacts.list(member));
    if(request.method==="POST")return artifacts.upload(request,member);
   }
   if(path.startsWith("/api/member/models/")&&request.method==="DELETE"){
    if(!artifacts)throw new RelayError("모델 업로드 저장소를 준비하고 있습니다.",503);
    return artifacts.remove(member,path.slice("/api/member/models/".length));
   }
   if(path==="/api/member/devices"&&request.method==="POST")return Response.json(await registerDevice(member,await readBody(request)));
   if(path==="/api/member/command"&&request.method==="POST"){
    const body=await readBody(request);
    const run=modelArtifact=>execute(store,POOL,{mode:"live",action:body.action,payload:body.payload,requestId:body.requestId},{memberAccount:member.account,modelArtifact});
    if(body.action==="rent"||body.action==="chat"&&body.payload?.rentalId===undefined){
     if(!artifacts)throw new RelayError("모델 업로드 저장소를 준비하고 있습니다.",503);
     return Response.json(await artifacts.withOwned(member,body.payload?.artifactId,run));
    }
    return Response.json(await run());
   }
  }else{
   limit("participation-public:"+ip,180);
   if(path==="/api/participation/info"&&request.method==="GET"){const value=origin();return Response.json({coordinator:value,localOnly:isLoopback(new URL(value).hostname),signupCredits});}
   if(path==="/api/participation/provider.zip"&&request.method==="GET"){
    limit("participation-download:"+ip,12);
    try{return new Response(await providerArchive(root,{coordinator:origin()}),{headers:{"Content-Type":"application/zip","Content-Disposition":"attachment; filename=Relay-Provider.zip"}});}catch{throw new RelayError("제공자 설치 파일이 누락되었습니다. 운영자에게 알려주세요.",503);}
   }
   if(path==="/api/participation/request"&&request.method==="POST")throw new RelayError("운영자 승인은 필요하지 않습니다. 내 GPU 연결하기에서 회원 등록 후 PC를 직접 연결하세요.",410);
   if(path==="/api/participation/status"&&request.method==="POST")return Response.json(await legacyStatus(await readBody(request)));
   if(path==="/api/participation/pair"&&request.method==="POST"){
    limit("participation-pair:"+ip,30);
    return Response.json(await pairDevice(await readBody(request)));
   }
   if(path==="/api/participation/verify"&&request.method==="POST"){
    const body=await readBody(request);validateToken(body.token);
    const {node,model}=await authenticatedNode(body.node,await hash(body.token));
    const status=node.status==="paused"?"paused":node.lastSeen>0&&node.lastSeen>now()-45000?"online":"offline";
    return Response.json({name:node.name,status,model:modelContract(model)});
   }
  }
  throw new RelayError("회원 API 또는 요청 방식을 확인하세요.",404);
 };
}
