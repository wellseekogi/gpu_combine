// Uses the existing browser runner; GPU responses are synthetic UI contract fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {bootAuditServer} from "./audit-server-helper.mjs";
const {chromium} = await import(process.env.RELAY_AUDIT_PLAYWRIGHT ? pathToFileURL(process.env.RELAY_AUDIT_PLAYWRIGHT).href : "playwright");

test("execution workspace UI: selection, stable address, recovery, history and release", {timeout:90000}, async () => {
  const server = await bootAuditServer();
  const browser = await chromium.launch({headless:true, ...(process.env.RELAY_AUDIT_BROWSER ? {executablePath:process.env.RELAY_AUDIT_BROWSER} : {channel:"chrome"})});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {value:{writeText:async value => { window.copiedWorkspaceKey = value; }}}));
  const errors = [], requests = [];
  const accessKey = "d".repeat(64);
  page.on("pageerror", error => errors.push(error.message));
  const candidate = {id:"main~spare",model:"test-model",primaryGroupId:"main",standbyGroupId:"spare",contextTokens:8192,
    quantization:"Q4_K_M",engineVersion:"test-engine",totalHourlyCost:2,currency:"USD",selectable:true,
    performance:{primary:{source:"estimated",firstTokenMs:1000,tokensPerSecond:10,completionRate:0.9,measuredAt:null,samples:0,conditions:{inputTokens:100,outputTokens:50}},standby:null}};
  const single = {...candidate,id:"main",standbyGroupId:null,totalHourlyCost:1};
  const groups = ["main","spare"].map(id => ({id,model:"test-model",topology:"lan",status:"ready",epoch:"test",contextTokens:8192,
    slots:1,active:0,gpus:[],requests:0,failures:0,promptTokens:0,outputTokens:0,generationMs:0}));
  let configured = false, workspace, releaseResponse;
  const reply = content => ({choices:[{message:{role:"assistant",content},finish_reason:"stop"}]});
  await page.route("**/api/inference**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = body => route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
    if (path === "/api/inference") return json(configured
      ? {enabled:true,groups,candidates:workspace && workspace.status !== "stopped" ? [] : [single,candidate],workspaces:workspace ? [workspace] : []}
      : {enabled:false,groups:[],candidates:[],workspaces:[]});
    if (path === "/api/inference/workspaces" && request.method() === "POST") {
      const selected = request.postDataJSON().candidateId === single.id ? single : candidate;
      assert.deepEqual(request.postDataJSON(), {candidateId:selected.id,name:"내 실행 공간"});
      workspace = {...selected,id:"test-workspace",candidateId:selected.id,name:"내 실행 공간",activeGroupId:"main",status:"ready",active:false,
        endpoint:"/v1/workspaces/test-workspace/chat/completions",recoveries:0,lastRecoveryMs:null,lastError:null};
      return json({...workspace, accessKey});
    }
    if (path === "/api/inference/workspaces/test-workspace" && request.method() === "DELETE") {
      workspace.status = "stopped";
      return json(workspace);
    }
    if (path === "/api/inference/workspaces/test-workspace/chat") {
      requests.push(request.postDataJSON());
      if (requests.length === 1) {
        workspace.status = "recovering"; workspace.active = true;
        await new Promise(accept => { releaseResponse = accept; });
        workspace.status = "degraded"; workspace.active = false; workspace.recoveries = 1; workspace.lastRecoveryMs = 1500;
        return route.fulfill({status:200,contentType:"application/json",headers:{"X-Relay-Recovered":"true"},body:JSON.stringify(reply("복구된 답변"))});
      }
      return json(reply("후속 답변"));
    }
    return route.continue();
  });
  try {
    assert.equal((await page.request.post(server.origin + "/api/login", {data:{token:server.admin}})).status(), 200);
    await page.goto(server.origin);
    await page.getByRole("button", {name:"분산 LLM",exact:true}).click();
    await page.getByRole("heading", {name:"전용 실행 공간",exact:true}).waitFor();
    await page.getByRole("heading", {name:"분산 실행 그룹이 아직 없습니다.",exact:true}).waitFor();
    assert.equal(await page.getByRole("button", {name:"실행 공간 만들기",exact:true}).count(), 0);
    await page.getByText("분산 LLM 준비 방법", {exact:true}).click();
    await page.getByText("RELAY_INFERENCE_CONFIG", {exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "preparation instructions must fit mobile screens");
    await page.setViewportSize({width:1440,height:1000});
    configured = true;
    await page.getByRole("button", {name:"준비 후 다시 확인",exact:true}).click();
    await page.getByRole("cell").filter({hasText:"실측 기록 없음"}).waitFor();
    assert.match(await page.locator("#inference-candidate").innerText(), /main · 단일 그룹 · 1 USD/);
    await page.getByText("예비 그룹이 없어 장애 시 자동 전환하지 않습니다. 표시된 비용은 실행 그룹만 포함합니다.", {exact:true}).waitFor();
    assert.equal(await page.getByRole("cell", {name:/^예비 ·/}).count(), 0, "single-group candidates must not show an empty standby row");
    await page.locator("#inference-candidate").click();
    await page.getByRole("option", {name:"test-model · main + 예비 spare · 2 USD / 시간",exact:true}).click();
    await page.getByRole("cell", {name:"미측정",exact:true}).waitFor();
    assert.equal(await page.getByRole("button", {name:"실행 공간 만들기",exact:true}).isDisabled(), true);
    await page.getByLabel("공간 이름", {exact:true}).fill("내 실행 공간");
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "candidate details must fit mobile screens");
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole("button", {name:"실행 공간 만들기",exact:true}).click();
    const endpoint = page.getByLabel(/^고정 API 주소/);
    await endpoint.waitFor();
    assert.equal(await endpoint.inputValue(), server.origin + workspace.endpoint);
    assert.equal(await page.locator("#inference-model").isDisabled(), true);
    const keyInput = page.locator("#inference-workspace-key");
    assert.equal(await keyInput.getAttribute("type"), "password");
    assert.equal(await keyInput.inputValue(), accessKey);
    await page.getByRole("button", {name:"연결 키 복사",exact:true}).click();
    assert.equal(await page.evaluate(() => window.copiedWorkspaceKey), accessKey);
    const download = page.waitForEvent("download");
    await page.getByRole("button", {name:"연결 설정 저장",exact:true}).click();
    const file = await download;
    assert.equal(file.suggestedFilename(), "relay-workspace-test-workspace.json");
    assert.deepEqual(JSON.parse(await readFile(await file.path(), "utf8")), {endpoint:server.origin + workspace.endpoint, model:workspace.model, apiKey:accessKey});
    assert.equal(await page.evaluate(key => JSON.stringify({...localStorage, ...sessionStorage}).includes(key), accessKey), false);
    const prompt = page.locator("#inference-prompt");
    await prompt.fill("첫 질문");
    const sent = page.waitForRequest(request => request.url().endsWith("/test-workspace/chat"));
    await page.getByRole("button", {name:"보내기",exact:true}).click();
    await sent;
    await page.getByRole("button", {name:"상태 새로고침",exact:true}).click();
    await page.getByText("예비 그룹으로 전환 중입니다. 대화 기록으로 문맥을 다시 계산하고 미완료 답변을 새로 생성합니다.", {exact:true}).waitFor();
    assert.equal(await page.getByRole("log").count(), 0, "incomplete responses must not enter history");
    releaseResponse();
    await page.getByRole("log").getByText("복구된 답변", {exact:true}).waitFor();
    await page.getByText("예비 그룹으로 전환해 대화 기록으로 답변을 다시 생성했습니다.", {exact:true}).waitFor();
    assert.equal(await endpoint.inputValue(), server.origin + workspace.endpoint);
    await prompt.fill("다음 질문");
    await page.getByRole("button", {name:"보내기",exact:true}).click();
    await page.getByRole("log").getByText("후속 답변", {exact:true}).waitFor();
    assert.deepEqual(requests[1].messages.map(message => message.content), ["첫 질문","복구된 답변","다음 질문"]);
    assert.equal(requests[0].stream, false);
    assert.equal(requests[0].session_id, requests[1].session_id);
    assert.equal(JSON.stringify(requests).includes(accessKey), false, "operator chat must not put the connection key in model input");
    await prompt.fill("아직 보내지 않은 질문");
    await page.getByRole("button", {name:"워크스페이스",exact:true}).click();
    assert.equal(await prompt.isVisible(), false);
    await page.getByRole("button", {name:"분산 LLM",exact:true}).click();
    assert.equal(await keyInput.inputValue(), accessKey, "menu navigation must preserve the unsaved connection key");
    assert.equal(await prompt.inputValue(), "아직 보내지 않은 질문");
    await page.getByRole("log").getByText("후속 답변", {exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "workspace UI must fit mobile screens");
    await mkdir(resolve("work/validation-browser"), {recursive:true});
    await page.screenshot({path:resolve("work/validation-browser/workspace-mobile.png"),fullPage:true});
    workspace.status = "preparing";
    await page.setViewportSize({width:1440,height:1000});
    await page.reload();
    await page.getByRole("button", {name:"분산 LLM",exact:true}).click();
    await page.locator("#inference-workspace").click();
    await page.getByRole("option", {name:"내 실행 공간 · 준비 중",exact:true}).click();
    await page.getByText("연결 키는 다시 표시할 수 없습니다. 저장한 연결 설정을 사용하거나, 키를 보관하지 않았다면 새 실행 공간을 만드세요.", {exact:true}).waitFor();
    assert.equal(await keyInput.count(), 0);
    await prompt.fill("재시작 후 질문");
    assert.equal(await page.getByRole("button", {name:"보내기",exact:true}).isEnabled(), true, "restored spaces must be able to recheck preparation on request");
    await page.getByRole("button", {name:"실행 공간 종료",exact:true}).click();
    await page.getByText("실행 공간을 종료하고 자원 예약을 해제했습니다.", {exact:true}).waitFor();
    await prompt.fill("종료 후 질문");
    assert.equal(await page.getByRole("button", {name:"보내기",exact:true}).isDisabled(), true);
    await page.locator("#inference-candidate").click();
    await page.getByRole("option", {name:"test-model · main · 단일 그룹 · 1 USD / 시간",exact:true}).click();
    await page.getByLabel("공간 이름", {exact:true}).fill("내 실행 공간");
    await page.getByRole("button", {name:"실행 공간 만들기",exact:true}).click();
    await page.getByText("예비 그룹이 없어 장애 시 자동 전환하지 않습니다.", {exact:true}).waitFor();
    assert.equal(workspace.candidateId, "main");
    assert.equal(workspace.standbyGroupId, null);
    await page.getByText("선택한 구성 main · 단일 그룹 · 현재 실행 main", {exact:true}).waitFor();
    workspace.status = "degraded";
    await page.getByRole("button", {name:"상태 새로고침",exact:true}).click();
    await page.getByText("다음 요청에서 실행 그룹의 연결과 준비 상태를 다시 확인합니다.", {exact:true}).waitFor();
    assert.match(await page.locator("#inference-workspace").innerText(), /상태 확인 필요/);
    assert.equal(await page.getByText(/예비 상태도 확인해야 합니다/).count(), 0);
    await prompt.fill("실행 상태 재확인");
    assert.equal(await page.getByRole("button", {name:"보내기",exact:true}).isEnabled(), true);
    assert.deepEqual(errors, []);
  } catch (error) {
    await mkdir(resolve("work/validation-browser"), {recursive:true});
    await page.screenshot({path:resolve("work/validation-browser/workspace-failure.png"),fullPage:true}).catch(() => {});
    throw error;
  } finally {
    releaseResponse?.();
    await browser.close();
    await server.close();
  }
});
