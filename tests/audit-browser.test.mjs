// Optional browser suite: install Playwright or set RELAY_AUDIT_PLAYWRIGHT to its index.mjs.
// Uses an isolated browser profile, temporary SQLite directory and generated test credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {bootAuditServer} from './audit-server-helper.mjs';
const {chromium} = await import(process.env.RELAY_AUDIT_PLAYWRIGHT
  ? pathToFileURL(process.env.RELAY_AUDIT_PLAYWRIGHT).href : 'playwright');
const artifactDir = resolve('work/validation-browser');

test('browser audit: ordinary demo and retry after losing a committed response', {timeout: 90000}, async t => {
  const server = await bootAuditServer();
  const browser = await chromium.launch({headless: true,
    ...(process.env.RELAY_AUDIT_BROWSER ? {executablePath: process.env.RELAY_AUDIT_BROWSER} : {channel: 'chrome'})});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const audit = (name, check) => t.test(name, async () => {
    try { await check(); }
    catch (error) {
      const file=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'')+'.png';
      await page.screenshot({path:resolve(artifactDir,'failure-'+file),fullPage:true,timeout:5000}).catch(() => {});
      console.log(JSON.stringify({scenario:'browser-audit-failure',name,url:page.url(),error:error.message}));
      throw error;
    }
  });
  async function state() {
    const response = await page.request.get(server.origin + '/api/relay');
    assert.equal(response.status(), 200);
    return (await response.json()).state;
  }
  try {
    await mkdir(artifactDir, {recursive: true});
    await page.goto(server.origin);
    await page.getByText('스케줄링 서버 운영자 로그인', {exact: true}).click();
    await page.getByLabel('관리자 키', {exact: true}).fill(server.admin);
    await page.getByRole('button', {name: '로그인', exact: true}).click();
    await page.getByRole('button', {name: '시작하기', exact: true}).click();
    await page.getByRole('button', {name: /먼저 체험하기/}).waitFor();
    await audit('demo creation, eventual completion, mode isolation and error-free rendering', async () => {
      await page.getByRole('button', {name: /먼저 체험하기/}).click();
      await page.getByRole('button', {name: '작업 실행', exact: true}).click();
      await page.waitForFunction(() => !document.body.innerText.includes('제출 중…'));
      const deadline = Date.now() + 20000;
      let current;
      while (Date.now() < deadline) {
        current = await state();
        if (current.books.demo.jobs[0]?.status === 'completed') break;
        await new Promise(accept => setTimeout(accept, 300));
      }
      assert.equal(current.books.demo.jobs[0]?.status, 'completed');
      assert.equal(current.books.live.jobs.length, 0);
      assert.equal(current.books.demo.jobs[0].spent, 30);
      assert.deepEqual(errors, []);
      await page.screenshot({path: resolve(artifactDir, 'demo-completed.png'), fullPage: true});
      await page.keyboard.press('Escape');
    });
    await audit('same form retry after committed response loss must create only one job', async () => {
      await page.getByRole('button', {name: /먼저 체험하기/}).click();
      let calls = 0;
      const requestIds = [];
      const before = (await state()).books.demo.jobs.length;
      await page.route('**/api/relay', async route => {
        const request = route.request();
        if (request.method() === 'POST' && request.postDataJSON()?.action === 'create') {
          requestIds.push(request.postDataJSON().requestId);
          calls++;
          if (calls === 1) {
            const upstream = await route.fetch();
            assert.equal(upstream.status(), 200); // The server has durably committed the job.
            await route.abort('connectionreset'); // Only its response is lost.
            return;
          }
        }
        await route.continue();
      });
      await page.getByRole('button', {name: '작업 실행', exact: true}).click();
      await page.getByRole('button', {name: '작업 실행', exact: true}).waitFor({state: 'visible'});
      await page.getByRole('button', {name: '작업 실행', exact: true}).click();
      await page.getByRole('heading', {name: '공개 기술 문서 비교', exact: true}).waitFor();
      const after = (await state()).books.demo.jobs.length;
      await page.screenshot({path: resolve(artifactDir, 'lost-response-retry.png'), fullPage: true});
      console.log(JSON.stringify({scenario: 'committed-response-loss', requests: calls,
        distinctRequestIds: new Set(requestIds).size, createdJobs: after - before}));
      assert.equal(after - before, 1, 'Retrying the unchanged form duplicated the committed job');
      assert.equal(new Set(requestIds).size, 1, 'An uncertain submission must retain its original request ID');
      await page.unroute('**/api/relay');
      const jobId = (await state()).books.demo.jobs[0].id;
      const deadline = Date.now() + 15000;
      let settled;
      while (Date.now() < deadline) {
        settled = (await state()).books.demo.jobs.find(job => job.id === jobId);
        if (settled.status === 'completed') break;
        await new Promise(accept => setTimeout(accept, 300));
      }
      assert.equal(settled.status, 'completed');
      assert.equal(settled.spent, 30);
      assert.equal((await state()).books.demo.ledger.filter(entry => entry.type === 'settlement' && entry.jobId === jobId).length, 3);
      await page.keyboard.press('Escape');
    });
    await audit('an explicitly new form creates a new job even with identical contents', async () => {
      const before = (await state()).books.demo.jobs.length;
      await page.getByRole('button', {name: /먼저 체험하기/}).click();
      await page.getByRole('button', {name: '작업 실행', exact: true}).click();
      await page.getByRole('heading', {name: '공개 기술 문서 비교', exact: true}).waitFor();
      assert.equal((await state()).books.demo.jobs.length - before, 1);
      await page.keyboard.press('Escape');
    });
    await audit('editing an uncertain draft creates a distinct request', async () => {
      const before = (await state()).books.demo.jobs.length;
      const ids = [];
      await page.getByRole('button', {name: /먼저 체험하기/}).click();
      await page.route('**/api/relay', async route => {
        if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'create') {
          ids.push(route.request().postDataJSON().requestId);
          if (ids.length === 1) {
            assert.equal((await route.fetch()).status(), 200);
            await route.abort('connectionreset');
            return;
          }
        }
        await route.continue();
      });
      try {
        await page.getByRole('button', {name: '작업 실행', exact: true}).click();
        await page.getByRole('button', {name: '작업 실행', exact: true}).waitFor();
        await page.getByLabel('작업 이름', {exact: true}).fill('Edited audit draft');
        await page.getByRole('button', {name: '작업 실행', exact: true}).click();
        await page.getByRole('heading', {name: 'Edited audit draft', exact: true}).waitFor();
        assert.equal(ids.length, 2);
        assert.equal(new Set(ids).size, 2);
        assert.equal((await state()).books.demo.jobs.length - before, 2);
        await page.keyboard.press('Escape');
      } finally { await page.unroute('**/api/relay'); }
    });
    await audit('PC registration retry retains both its request ID and usable provider key', async () => {
      const response = await page.request.post(server.origin + '/api/relay', {data: {
        mode: 'live', action: 'model', requestId: crypto.randomUUID(),
        payload: {name: 'Audit model', digest: 'a'.repeat(64), runtime: 'b'.repeat(64), template: 'c'.repeat(64), context: 8192, minVram: 0},
      }});
      assert.equal(response.status(), 200);
      await page.reload();
      await page.getByRole('button', {name: 'GPU 노드', exact: true}).click();
      await page.getByRole('button', {name: '실제 실행', exact: true}).click();
      await page.getByRole('button', {name: '노드 연결', exact: true}).click();
      await page.getByLabel('PC 이름', {exact: true}).fill('Audit PC');
      const before = (await state()).books.live.nodes.length;
      const ids = [], keys = [];
      await page.route('**/api/relay', async route => {
        const request = route.request();
        if (request.method() === 'POST' && request.postDataJSON()?.action === 'node') {
          const command = request.postDataJSON();
          ids.push(command.requestId); keys.push(command.payload.token);
          if (ids.length === 1) {
            assert.equal((await route.fetch()).status(), 200);
            await route.abort('connectionreset');
            return;
          }
        }
        await route.continue();
      });
      try {
        await page.getByRole('button', {name: '연결 설정 만들기', exact: true}).click();
        await page.getByRole('button', {name: '연결 설정 만들기', exact: true}).waitFor();
        await page.getByRole('button', {name: '연결 설정 만들기', exact: true}).click();
        await page.getByRole('heading', {name: '연결 설정이 준비되었어요', exact: true}).waitFor();
        const nodes = (await state()).books.live.nodes;
        assert.equal(nodes.length - before, 1);
        assert.equal(ids.length, 2);
        assert.equal(new Set(ids).size, 1);
        assert.equal(new Set(keys).size, 1);
        const provider = await page.request.post(server.origin + '/api/provider', {
          headers: {Authorization: 'Bearer ' + keys[0]},
          data: {poolId: 'local-owner', nodeId: nodes.find(node => node.name === 'Audit PC').id, action: 'status', payload: {}},
        });
        assert.equal(provider.status(), 200);
        assert.deepEqual(errors, []);
      } finally { await page.unroute('**/api/relay'); }
    });
  } finally { await browser.close(); await server.close(); }
});
