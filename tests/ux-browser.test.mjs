// UX regressions against an isolated real server; only the connection failure is simulated.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {bootAuditServer} from "./audit-server-helper.mjs";
const {chromium} = await import(process.env.RELAY_AUDIT_PLAYWRIGHT
  ? pathToFileURL(process.env.RELAY_AUDIT_PLAYWRIGHT).href : "playwright");

test("UX: preparation, history, deletion confirmation, search, mobile header and reconnect", {timeout:90000}, async t => {
  const server = await bootAuditServer();
  t.after(() => server.close());
  const browser = await chromium.launch({headless:true,
    ...(process.env.RELAY_AUDIT_BROWSER ? {executablePath:process.env.RELAY_AUDIT_BROWSER} : {channel:"chrome"})});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const button = name => page.getByRole("button", {name,exact:true});
  const member = page.getByRole("dialog", {name:"내 GPU·토큰",exact:true});
  const result = page.getByRole("dialog", {name:"공개 기술 문서 비교",exact:true});
  const jobRow = page.locator(".job-link").filter({hasText:"공개 기술 문서 비교"});
  const out = resolve("work/ux-regression-browser");
  await mkdir(out, {recursive:true});
  try {
    await page.goto(server.origin);
    await button("GPU에서 LLM 실행").click();
    await member.waitFor();
    assert.equal(new URL(page.url()).hash, "#run-llm");
    await page.goBack();
    await member.waitFor({state:"hidden"});
    assert.equal(new URL(page.url()).hash, "");
    await page.goForward();
    await member.waitFor();
    assert.equal(new URL(page.url()).hash, "#run-llm");
    await page.keyboard.press("Escape");
    await member.waitFor({state:"hidden"});

    await page.getByText("스케줄링 서버 운영자 로그인", {exact:true}).click();
    await page.getByLabel("관리자 키", {exact:true}).fill(server.admin);
    await button("로그인").click();
    await button("로그아웃").waitFor();
    // Both shared create controls must lead to preparation from every empty-list location.
    for (const section of ["작업", "워크스페이스"]) {
      for (const entry of ["새 작업", "작업 만들기"]) {
        await button(section).click();
        await button("실제 실행").click();
        await button(entry).click();
        await page.getByRole("heading", {name:"시작하기",exact:true}).waitFor();
        assert.equal(await page.getByRole("dialog").count(), 0, `${section}: ${entry} opened an unusable form`);
      }
    }
    await button("크레딧 원장").click();
    await button("새 작업").click();
    await page.getByRole("heading", {name:"시작하기",exact:true}).waitFor();

    const nodeIds = [];
    for (const [name, digest] of [["A", "a"], ["B", "b"]]) {
      const model = await page.request.post(server.origin + "/api/relay", {data:{
        mode:"live",action:"model",requestId:crypto.randomUUID(),
        payload:{name:`UX 모델 ${name}`,digest:digest.repeat(64),runtime:"c".repeat(64),template:"d".repeat(64),context:8192,minVram:0},
      }});
      assert.equal(model.status(), 200, await model.text());
      const node = await page.request.post(server.origin + "/api/relay", {data:{
        mode:"live",action:"node",requestId:crypto.randomUUID(),
        payload:{name:`UX PC ${name}`,modelId:(await model.json()).result.modelId,vram:4096,token:crypto.randomUUID() + crypto.randomUUID()},
      }});
      assert.equal(node.status(), 200, await node.text());
      nodeIds.push((await node.json()).result.nodeId);
    }
    await page.reload();
    await button("작업").click();
    await button("실제 실행").click();
    await button("새 작업").click();
    const draft = page.getByRole("dialog", {name:"새 문서 추출 작업",exact:true});
    const firstNode = draft.getByRole("checkbox", {name:"UX PC A",exact:true});
    const secondNode = draft.getByRole("checkbox", {name:"UX PC B",exact:true});
    await firstNode.check();
    assert.equal(await secondNode.count(), 0, "only providers supporting the selected model should be offered");
    await draft.getByRole("combobox").first().click();
    await page.getByRole("option", {name:"UX 모델 B",exact:true}).click();
    await secondNode.waitFor();
    assert.equal(await firstNode.count(), 0);
    assert.equal(await secondNode.isChecked(), false);
    await draft.getByRole("combobox").first().click();
    await page.getByRole("option", {name:"UX 모델 A",exact:true}).click();
    await firstNode.waitFor();
    assert.equal(await firstNode.isChecked(), false, "changing model must clear the previous provider restriction");

    await firstNode.check();
    await draft.getByLabel("작업 이름", {exact:true}).fill("입력 유지 확인");
    await draft.getByLabel("문서 1 제목", {exact:true}).fill("작성 중인 문서");
    await draft.getByLabel(/^원문/).fill("선택한 제공자가 폐기되어도 보존할 원문");
    const revoke = await page.request.post(server.origin + "/api/relay", {data:{
      mode:"live",action:"revoke",requestId:crypto.randomUUID(),payload:{nodeId:nodeIds[0]},
    }});
    assert.equal(revoke.status(), 200, await revoke.text());
    await firstNode.waitFor({state:"detached"});
    const resetProviders = draft.getByRole("button", {name:"제공자 선택 초기화",exact:true});
    await resetProviders.waitFor(); // Revocation must not silently broaden the user's allowed providers.
    await resetProviders.click();
    await resetProviders.waitFor({state:"detached"});
    assert.equal(await draft.getByLabel("작업 이름", {exact:true}).inputValue(), "입력 유지 확인");
    assert.equal(await draft.getByLabel("문서 1 제목", {exact:true}).inputValue(), "작성 중인 문서");
    assert.equal(await draft.getByLabel(/^원문/).inputValue(), "선택한 제공자가 폐기되어도 보존할 원문");
    await page.keyboard.press("Escape");
    await draft.waitFor({state:"hidden"});
    await button("시작하기").click();

    await page.getByRole("button", {name:/먼저 체험하기/}).click();
    await button("작업 실행").click();
    await result.waitFor();
    await result.getByRole("button", {name:"원문·결과 삭제",exact:true}).waitFor({timeout:25000});
    await result.getByRole("button", {name:"원문·결과 삭제",exact:true}).click();
    const confirmation = page.getByRole("alertdialog");
    await confirmation.waitFor();
    assert.match(await confirmation.innerText(), /원문.*삭제/);
    await confirmation.getByRole("button", {name:"삭제",exact:true}).waitFor();
    await confirmation.getByRole("button", {name:"돌아가기",exact:true}).click();
    await confirmation.waitFor({state:"hidden"});
    assert.equal(await result.locator(".source-text pre").count(), 3);
    assert.ok((await result.locator(".source-text pre").allTextContents()).every(text => text.length > 0));
    await page.keyboard.press("Escape");
    await result.waitFor({state:"hidden"});

    await button("작업").click();
    await jobRow.waitFor();
    await page.getByLabel("작업 이름 검색", {exact:true}).fill("없는 작업 이름");
    await page.getByText("검색 결과가 없습니다", {exact:true}).waitFor();
    assert.equal(await page.getByText("첫 번째 작업을 만들어보세요", {exact:true}).count(), 0);
    await button("검색어 지우기").click();
    assert.equal(await page.getByLabel("작업 이름 검색", {exact:true}).inputValue(), "");
    await jobRow.waitFor();

    await button("설계와 운영").click();
    await page.setViewportSize({width:390,height:844});
    const title = page.locator(".workspace-section");
    await title.waitFor();
    const header = await title.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return {text:element.textContent, lines:new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
        width:element.getBoundingClientRect().width, right:element.closest("header").getBoundingClientRect().right,
        viewport:innerWidth};
    });
    assert.equal(header.text, "설계와 운영");
    assert.equal(header.lines, 1, "the current menu name wraps vertically on mobile");
    assert.ok(header.width > 30 && header.right <= header.viewport + 1, "the mobile header overflows");
    await page.screenshot({path:resolve(out,"mobile-header.png"),fullPage:true});
    await page.setViewportSize({width:1440,height:1000});

    await button("작업").click();
    await jobRow.waitFor();
    const offline = route => route.request().method() === "GET" ? route.abort("connectionrefused") : route.continue();
    await page.route("**/api/relay", offline);
    try {
      await page.getByText("서버 연결 끊김", {exact:true}).waitFor();
      await page.getByText(/마지막 갱신/).waitFor();
      assert.match(await page.locator(".error-banner").innerText(), /서버에 연결할 수 없습니다/);
      assert.equal(await page.getByText("스케줄러 연결됨", {exact:true}).count(), 0);
      assert.equal(await jobRow.isVisible(), true, "last successful data must remain available offline");
      await page.screenshot({path:resolve(out,"offline.png"),fullPage:true});
    } finally { await page.unroute("**/api/relay", offline); }
    await button("다시 연결").click();
    await page.getByText("스케줄러 연결됨", {exact:true}).waitFor();
    await page.locator(".error-banner").waitFor({state:"hidden"});
    assert.equal(await jobRow.isVisible(), true);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({path:resolve(out,"failure.png"),fullPage:true}).catch(() => {});
    throw error;
  }
});
