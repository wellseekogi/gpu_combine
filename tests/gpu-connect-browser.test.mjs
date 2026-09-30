// Personal accounts, immediate GPU listing and credit settlement through actual browser interactions.
// Isolated HTTP server; synthetic provider results do not launch GPU processes.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile, mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {bootAuditServer} from "./audit-server-helper.mjs";
const {chromium} = await import(process.env.RELAY_AUDIT_PLAYWRIGHT ? pathToFileURL(process.env.RELAY_AUDIT_PLAYWRIGHT).href : "playwright");
const contract = {version:1, modelDigest:"a".repeat(64), runtime:"b".repeat(64), template:"c".repeat(64), context:8192};
const upload = (name, value) => ({name, mimeType:"application/json", buffer:Buffer.from(JSON.stringify(value))});
const gguf = name => {
  // Container-header fixture only: the browser test does not execute a real model.
  const buffer=Buffer.alloc(128);buffer.write("GGUF");buffer.writeUInt32LE(3,4);buffer.write(name,24);
  return {name,mimeType:"application/octet-stream",buffer};
};
test("GPU rental opens a terminal, meters turns and releases the GPU", {timeout:120000}, async () => {
  const server=await bootAuditServer();
  const browser=await chromium.launch({headless:true,...(process.env.RELAY_AUDIT_BROWSER?{executablePath:process.env.RELAY_AUDIT_BROWSER}:{channel:"chrome"})});
  const alice=await browser.newPage({viewport:{width:1280,height:940}});
  const bob=await browser.newPage({viewport:{width:1180,height:850}});
  const errors=[];for(const page of [alice,bob])page.on("pageerror",error=>errors.push(error.message));
  const dialog=page=>page.getByRole("dialog",{name:"내 GPU·토큰",exact:true});
  const button=(page,name)=>dialog(page).getByRole("button",{name,exact:true});
  const headers=key=>({"X-Relay-Member":key.id,Authorization:"Bearer "+key.token});
  async function register(page,name) {
    await page.goto(server.origin+"/?view=connect-pc#connect-pc");
    await dialog(page).getByLabel("표시 이름",{exact:true}).fill(name);
    await button(page,"개인 계정 만들기").click();
    await page.getByTestId("member-available").waitFor();
    assert.equal(await page.getByTestId("member-available").innerText(),"100");
    const download=page.waitForEvent("download");
    await button(page,"계정 복구 파일 저장").click();
    return JSON.parse(await readFile(await(await download).path(),"utf8"));
  }
  async function refresh(page) {
    const response=page.waitForResponse(value=>value.url().endsWith("/api/member/me"));
    await button(page,"내 정보 새로고침").click();
    await(await response).finished();
  }
  async function provider(config,action,payload) {
    const response=await bob.context().request.post(server.origin+"/api/provider",{headers:{Authorization:"Bearer "+config.token},data:{poolId:config.pool,nodeId:config.node,action,payload}});
    assert.equal(response.status(),200,await response.text());
    return(await response.json()).result;
  }
  const poll=(config,extra={})=>provider(config,"poll",{modelDigest:contract.modelDigest,runtime:contract.runtime,template:contract.template,capabilities:["renter-model","rental-session"],...extra});
  try {
    const aliceKey=await register(alice,"Alice"),bobKey=await register(bob,"Bob");
    await button(bob,"연결 코드 만들기").click();
    const code=await dialog(bob).locator(".member-pairing-code").innerText();
    const token=crypto.randomUUID()+crypto.randomUUID();
    const paired=await bob.context().request.post(server.origin+"/api/participation/pair",{data:{code,requestId:crypto.randomUUID(),token,name:"Bob GPU",modelName:"Shared model",model:contract,vram:4096}});
    assert.equal(paired.status(),200,await paired.text());
    const {config}=await paired.json();
    await dialog(bob).getByTestId("member-node-"+config.node).waitFor();
    await refresh(alice);
    await dialog(alice).getByRole("tab",{name:"다른 GPU 사용",exact:true}).click();
    await button(alice,"현재 사용 불가").waitFor();
    await poll(config);
    await refresh(alice);
    await dialog(alice).getByLabel("사용할 GPU",{exact:true}).selectOption(config.node);
    const uploaded=alice.waitForResponse(response=>response.url().endsWith("/api/member/models")&&response.request().method()==="POST");
    await dialog(alice).getByLabel("내 GGUF 모델 파일",{exact:true}).setInputFiles(gguf("rental.gguf"));
    const uploadResponse=await uploaded;
    assert.equal(uploadResponse.status(),201,await uploadResponse.text());
    const {artifact}=await uploadResponse.json();
    await dialog(alice).getByLabel("실행할 내 모델",{exact:true}).selectOption(artifact.id);
    await dialog(alice).getByRole("checkbox").check();
    const rentRequest=alice.waitForRequest(request=>request.url().endsWith("/api/member/command")&&request.postDataJSON()?.action==="rent");
    await button(alice,"GPU 빌리고 LLM 열기").click();
    assert.equal((await rentRequest).postDataJSON().payload.artifactId,artifact.id);
    const terminal=dialog(alice).getByTestId("member-rental-terminal");
    await terminal.waitFor();
    await terminal.getByLabel("LLM 메시지").waitFor();
    assert.equal(await terminal.getByLabel("LLM 메시지").isDisabled(),true);
    const granted=await poll(config);
    assert.equal(granted.rental.modelArtifact.id,artifact.id);
    await poll(config,{rentalId:granted.rental.id,rentalStage:"ready"});
    await refresh(alice);
    await terminal.getByLabel("LLM 메시지").fill("첫 질문");
    const firstChat=alice.waitForResponse(response=>response.url().endsWith("/api/member/command")&&response.request().postDataJSON()?.action==="chat");
    await terminal.getByRole("button",{name:"전송",exact:true}).click();
    assert.equal((await firstChat).status(),200);
    const first=await poll(config,{rentalId:granted.rental.id,rentalStage:"ready"});
    assert.equal(first.task.kind,"chat");
    assert.equal(first.task.messages.at(-1).content,"첫 질문");
    await provider(config,"submit",{taskId:first.task.taskId,attemptId:first.task.lease.attemptId,epoch:first.task.lease.epoch,modelDigest:artifact.digest,runtime:contract.runtime,template:"d".repeat(64),finishReason:"stop",raw:"첫 답변",usage:{prompt_tokens:70,completion_tokens:30,total_tokens:100}});
    await refresh(alice);
    await terminal.getByText("첫 답변",{exact:true}).waitFor();
    assert.match(await terminal.innerText(),/사용 요금 1 CR/);
    await terminal.getByRole("button",{name:"새 대화",exact:true}).click();
    await terminal.getByText("첫 답변",{exact:true}).waitFor({state:"detached"});
    await terminal.getByLabel("LLM 메시지").fill("새 질문");
    const secondChat=alice.waitForResponse(response=>response.url().endsWith("/api/member/command")&&response.request().postDataJSON()?.action==="chat");
    await terminal.getByRole("button",{name:"전송",exact:true}).click();
    assert.equal((await secondChat).status(),200);
    const second=await poll(config,{rentalId:granted.rental.id,rentalStage:"ready"});
    assert.equal(second.task.messages.at(-1).content,"새 질문");
    await provider(config,"submit",{taskId:second.task.taskId,attemptId:second.task.lease.attemptId,epoch:second.task.lease.epoch,modelDigest:artifact.digest,runtime:contract.runtime,template:"d".repeat(64),finishReason:"stop",raw:"새 답변",usage:{prompt_tokens:1000,completion_tokens:1,total_tokens:1001}});
    await refresh(alice);
    await terminal.getByText("새 답변",{exact:true}).waitFor();
    assert.match(await terminal.innerText(),/사용 요금 3 CR/);
    await terminal.getByRole("button",{name:"GPU 임대 종료",exact:true}).click();
    await terminal.getByRole("button",{name:"다른 GPU 빌리기",exact:true}).waitFor();
    const me=await alice.context().request.get(server.origin+"/api/member/me",{headers:headers(aliceKey)});
    assert.equal(me.status(),200);
    const rental=(await me.json()).state.books.live.jobs.find(job=>job.kind==="rental");
    assert.equal(rental.status,"cancelled");
    assert.equal(rental.spent,3);
    assert.equal((await bob.context().request.get(server.origin+"/api/member/me",{headers:headers(bobKey)})).status(),200);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();await server.close();}
});
test("public landing offers own LLM rental first and fits mobile screens", {timeout:60000}, async () => {
  const server=await bootAuditServer();
  const browser=await chromium.launch({headless:true,...(process.env.RELAY_AUDIT_BROWSER?{executablePath:process.env.RELAY_AUDIT_BROWSER}:{channel:"chrome"})});
  const page=await browser.newPage({viewport:{width:1440,height:1080}});
  const out=resolve("work/renter-browser");await mkdir(out,{recursive:true});
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  try {
    await page.goto(server.origin);
    const hero=page.locator(".compute-hero");
    await hero.getByRole("heading",{level:1,name:/다른 사람의 GPU에서/}).waitFor();
    assert.match(await hero.innerText(),/실행하고 싶은 LLM을 올리세요/);
    await page.screenshot({path:resolve(out,"renter-home-desktop.png"),fullPage:true,animations:"disabled"});
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth+1);
    await page.screenshot({path:resolve(out,"renter-home-mobile.png"),fullPage:true,animations:"disabled"});
    await hero.getByRole("button",{name:"GPU에서 LLM 실행",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"내 GPU·토큰",exact:true});
    await dialog.getByText("다른 GPU를 빌려 내 LLM을 실행하세요",{exact:true}).waitFor();
    await dialog.getByLabel("표시 이름",{exact:true}).fill("Renter landing QA");
    await dialog.getByRole("button",{name:"개인 계정 만들기",exact:true}).click();
    await dialog.getByRole("heading",{name:"다른 GPU 빌리기",exact:true}).waitFor();
    assert.equal(await dialog.getByRole("tab",{name:"다른 GPU 사용",exact:true}).getAttribute("aria-selected"),"true");
    assert.equal(await dialog.getByLabel("찾을 항목",{exact:true}).count(),0);
    await dialog.getByText("지금 실행 가능한 GPU가 없습니다.",{exact:true}).waitFor();
    assert.equal(await dialog.getByLabel("내 GGUF 모델 파일",{exact:true}).count(),0,"do not request a large model upload before a usable GPU is selected");
    assert.equal(await dialog.getByLabel("프롬프트",{exact:true}).count(),0);
    const useTab=dialog.getByRole("tab",{name:"다른 GPU 사용",exact:true});await useTab.focus();await useTab.press("ArrowRight");
    const provideTab=dialog.getByRole("tab",{name:"내 GPU 제공",exact:true});
    await dialog.getByRole("tabpanel",{name:"내 GPU 제공",exact:true}).waitFor();
    assert.equal(await provideTab.getAttribute("aria-selected"),"true");assert.equal(await provideTab.evaluate(element=>document.activeElement===element),true);
    assert.equal(await useTab.getAttribute("tabindex"),"-1");assert.equal(await dialog.getByLabel("모델 이름",{exact:true}).count(),0,"GPU-only setup must not ask for a model before a contract is imported");
    await provideTab.press("ArrowLeft");await dialog.getByRole("tabpanel",{name:"다른 GPU 사용",exact:true}).waitFor();
    await dialog.getByRole("button",{name:"GPU 목록 새로고침",exact:true}).click();
    await page.waitForFunction(()=>{const element=document.querySelector(".member-dialog");return element&&element.scrollWidth<=element.clientWidth+1&&element.getBoundingClientRect().right<=window.innerWidth+1;});
    await dialog.locator(".participant-panel").evaluate(element=>{element.scrollTop=0;});
    await page.screenshot({path:resolve(out,"renter-upload-mobile.png"),animations:"disabled"});
    assert.deepEqual(errors,[]);
  } finally {await browser.close();await server.close();}
});

test("GPU registration gives visible recovery, upload and field feedback before creating a device", {timeout:120000}, async () => {
  const server = await bootAuditServer();
  const browser = await chromium.launch({headless:true, ...(process.env.RELAY_AUDIT_BROWSER ? {executablePath:process.env.RELAY_AUDIT_BROWSER} : {channel:"chrome"})});
  const page = await browser.newPage({viewport:{width:390,height:844}});
  const out=resolve("work/member-browser");await mkdir(out,{recursive:true});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  const requests=[];
  page.on("request",request=>{if(request.url().endsWith("/api/member/devices"))requests.push(request.postDataJSON());});
  const dialog=page.getByRole("dialog",{name:"내 GPU·토큰",exact:true});
  const form=dialog.locator(".member-device-form");
  const button=name=>form.getByRole("button",{name,exact:true});
  const modelInput=dialog.getByLabel("실행 환경 확인 파일",{exact:true});
  async function feedback(message) {
    await form.getByRole("alert").filter({hasText:message}).waitFor();
    const box=await form.getByRole("alert").boundingBox();
    assert(box && box.y>=0 && box.y+box.height<=844,"registration feedback must be visible in a small viewport");
  }
  try {
    await page.addInitScript(() => {
      const read=File.prototype.text;
      File.prototype.text=async function() {
        if(this.name==="slow-model.json")await new Promise(resolve=>{window.finishSlowModel=resolve;});
        return read.call(this);
      };
    });
    await page.goto(server.origin+"/?view=connect-pc#connect-pc");
    await dialog.getByLabel("표시 이름",{exact:true}).fill("Registration feedback QA");
    await dialog.getByRole("button",{name:"개인 계정 만들기",exact:true}).click();
    await dialog.getByText("기존 JSON 파일로 연결하기").click();
    await modelInput.waitFor({state:"attached"});
    await modelInput.setInputFiles(upload("relay-model-contract.json",contract));
    await form.getByRole("status").filter({hasText:"확인 완료:"}).waitFor();
    assert.match(await form.locator("#device-registration-help").innerText(),/계정 복구 파일을 먼저 저장/);
    assert.equal(await button("내 GPU 등록하기").isEnabled(),true,"the submit button must explain prerequisites when clicked");
    await button("내 GPU 등록하기").click();
    await feedback("계정 복구 파일 저장하고 계속");
    await page.screenshot({path:resolve(out,"registration-recovery-feedback.png"),animations:"disabled"});
    assert.equal(requests.length,0);
    const pending=page.waitForEvent("download");
    await button("계정 복구 파일 저장하고 계속").click();
    assert.equal(JSON.parse(await readFile(await(await pending).path(),"utf8")).kind,"relay-member-account");
    assert.match(await form.locator("#device-registration-help").innerText(),/PC 이름을 입력/);
    await button("내 GPU 등록하기").click();await feedback("PC 이름을 입력하세요");
    await dialog.getByLabel("PC 이름",{exact:true}).fill("Feedback PC");
    assert.match(await form.locator("#device-registration-help").innerText(),/모델 이름을 입력/);
    await button("내 GPU 등록하기").click();await feedback("모델 이름을 입력하세요");
    await dialog.getByLabel("모델 이름",{exact:true}).fill("Feedback model");
    await dialog.getByLabel("GPU 메모리 (GB)",{exact:true}).fill("0");
    await button("내 GPU 등록하기").click();await feedback("GPU 메모리를 1~195 GB");
    await dialog.getByLabel("GPU 메모리 (GB)",{exact:true}).fill("4");
    await modelInput.setInputFiles(upload("wrong-file.json",{kind:"relay-member-account"}));
    await feedback("파일 확인 정보가 올바르지 않습니다");
    await button("내 GPU 등록하기").click();await feedback("실행 환경 확인 파일을 먼저 가져오세요");
    await modelInput.setInputFiles(upload("slow-model.json",{...contract,context:4096}));
    await button("실행 환경 확인 파일 읽는 중…").waitFor();
    assert.equal(await button("실행 환경 확인 파일 읽는 중…").isDisabled(),true);
    await modelInput.setInputFiles(upload("latest-model.json",contract));
    await form.getByRole("status").filter({hasText:"latest-model.json · 문맥 8192"}).waitFor();
    await page.evaluate(()=>window.finishSlowModel());
    await page.route("**/api/member/devices",async route=>{
      if(requests.length===1)await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"등록 서버가 잠시 응답하지 않습니다. 다시 시도하세요."})});
      else await route.continue();
    });
    await button("내 GPU 등록하기").click();await feedback("등록 서버가 잠시 응답하지 않습니다");
    await button("내 GPU 등록하기").click();
    await dialog.getByRole("heading",{name:"GPU 연결 설정이 준비되었습니다",exact:true}).waitFor();
    await dialog.getByText("아래 ‘연결 설정 저장’을 눌러야 PC 도우미가 연결 파일을 찾을 수 있습니다.",{exact:true}).waitFor();
    assert.equal(requests.length,2);assert.equal(requests[0].requestId,requests[1].requestId);
    assert.equal(requests[1].model.context,8192,"an older upload must not replace the latest selected model");
    await page.screenshot({path:resolve(out,"registration-mobile-complete.png"),animations:"disabled"});
    const connectionDownload=page.waitForEvent("download");
    await dialog.getByRole("button",{name:"연결 설정 저장",exact:true}).click();
    const downloaded=await connectionDownload;
    const config=JSON.parse(await readFile(await downloaded.path(),"utf8"));
    assert.equal(downloaded.suggestedFilename(),"relay-provider-"+config.node+".json");
    assert.equal(config.model.context,8192);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();await server.close();}
});

test("old connection files reuse the same account and PC on the current server", {timeout:60000}, async () => {
  const server=await bootAuditServer();
  const browser=await chromium.launch({headless:true,...(process.env.RELAY_AUDIT_BROWSER?{executablePath:process.env.RELAY_AUDIT_BROWSER}:{channel:"chrome"})});
  const page=await browser.newPage();
  const member={id:crypto.randomUUID(),token:crypto.randomUUID()+crypto.randomUUID(),name:"Returning member"};
  const pcToken=crypto.randomUUID()+crypto.randomUUID();
  const headers={"X-Relay-Member":member.id,Authorization:"Bearer "+member.token};
  const oldAddress="https://old-relay.example.test";
  const dialog=page.getByRole("dialog",{name:"내 GPU·토큰",exact:true});
  async function download(name) {
    const pending=page.waitForEvent("download");
    await dialog.getByRole("button",{name,exact:true}).click();
    return JSON.parse(await readFile(await(await pending).path(),"utf8"));
  }
  try {
    const registered=await page.context().request.post(server.origin+"/api/member/register",{data:member});
    assert.equal(registered.status(),200,await registered.text());
    const device=await page.context().request.post(server.origin+"/api/member/devices",{headers,data:{requestId:crypto.randomUUID(),token:pcToken,name:"Same desktop",modelName:"Shared model",model:contract,vram:4096}});
    assert.equal(device.status(),200,await device.text());
    const config={...(await device.json()).config,token:pcToken};
    await page.goto(server.origin+"/?view=connect-pc#connect-pc");
    const account={version:1,kind:"relay-member-account",coordinator:oldAddress,...member};
    await dialog.getByLabel("계정 복구 파일",{exact:true}).setInputFiles(upload("account.json",{...account,token:pcToken}));
    await dialog.getByRole("alert").filter({hasText:"회원 인증 정보를 확인하세요"}).waitFor();
    await dialog.getByLabel("계정 복구 파일",{exact:true}).setInputFiles(upload("account.json",account));
    await page.getByTestId("member-node-"+config.node).waitFor();
    const restoredAccount=await download("계정 복구 파일 저장");
    assert.equal(restoredAccount.id,member.id);
    assert.equal(restoredAccount.coordinator,server.origin);
    const oldConnection={...config,coordinator:oldAddress};
    await dialog.getByLabel("내 PC 연결 파일",{exact:true}).setInputFiles(upload("provider.json",{...oldConnection,token:member.token}));
    await dialog.getByRole("alert").filter({hasText:"PC 연결 키가 올바르지 않거나 폐기되었습니다"}).waitFor();
    await dialog.getByLabel("내 PC 연결 파일",{exact:true}).setInputFiles(upload("provider.json",oldConnection));
    await dialog.getByRole("status").filter({hasText:"기존 PC 연결을 확인했습니다"}).waitFor();
    const restoredConnection=await download("연결 설정 저장");
    assert.equal(restoredConnection.node,config.node);
    assert.equal(restoredConnection.token,pcToken);
    assert.equal(restoredConnection.coordinator,server.origin);
    const snapshot=await page.context().request.get(server.origin+"/api/member/me",{headers});
    assert.equal((await snapshot.json()).state.books.live.nodes.filter(node=>node.mine).length,1);
  } finally {await browser.close();await server.close();}
});

test("signup preserves the account and retries a delayed failed balance request", {timeout:60000}, async () => {
  const server=await bootAuditServer();
  const browser=await chromium.launch({headless:true,...(process.env.RELAY_AUDIT_BROWSER?{executablePath:process.env.RELAY_AUDIT_BROWSER}:{channel:"chrome"})});
  const page=await browser.newPage();
  const dialog=page.getByRole("dialog",{name:"내 GPU·토큰",exact:true});
  let releaseSnapshot=()=>{}, failSnapshot=true, registrations=0;
  const pendingSnapshot=new Promise(resolve=>{releaseSnapshot=resolve;});
  page.on("request",request=>{if(request.url().endsWith("/api/member/register"))registrations++;});
  await page.route("**/api/member/me",async route=>{
    if(!failSnapshot)return route.continue();
    await pendingSnapshot;
    await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"계정 정보 조회를 잠시 사용할 수 없습니다."})});
  });
  try {
    await page.goto(server.origin+"/?view=connect-pc#connect-pc");
    await dialog.getByLabel("표시 이름",{exact:true}).fill("Recoverable signup");
    await dialog.getByRole("button",{name:"개인 계정 만들기",exact:true}).click();
    await dialog.getByRole("status").filter({hasText:"계정 정보를 불러오는 중"}).waitFor();
    assert.equal(await page.getByTestId("member-available").count(),0,"unknown balances must not display as zero");
    assert.equal(await dialog.getByRole("tablist").count(),0,"GPU and history data are not loaded yet");
    const pendingDownload=page.waitForEvent("download");
    await dialog.getByRole("button",{name:"계정 복구 파일 저장",exact:true}).click();
    const account=JSON.parse(await readFile(await(await pendingDownload).path(),"utf8"));
    assert.equal(account.kind,"relay-member-account");
    releaseSnapshot();
    await dialog.getByRole("alert").filter({hasText:"계정 정보 조회를 잠시 사용할 수 없습니다"}).waitFor();
    await dialog.getByRole("status").filter({hasText:"내 정보 새로고침을 눌러 다시 시도하세요"}).waitFor();
    assert.equal(await page.getByTestId("member-available").count(),0);
    failSnapshot=false;
    await dialog.getByRole("button",{name:"내 정보 새로고침",exact:true}).click();
    await page.getByTestId("member-available").waitFor();
    assert.equal(await page.getByTestId("member-available").innerText(),"100");
    assert.equal(registrations,1);
    const response=await page.context().request.get(server.origin+"/api/member/me",{headers:{"X-Relay-Member":account.id,Authorization:"Bearer "+account.token}});
    assert.equal(response.status(),200);
    const member=await response.json();
    assert.equal(member.id,account.id);
    assert.equal(member.state.books.live.ledger.filter(entry=>entry.reason==="signup").length,1);
  } finally {releaseSnapshot();await browser.close();await server.close();}
});
