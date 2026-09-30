// Isolated real HTTP server for the 2026-09-18 validation audit.
// Never reads the operator's .relay directory or credentials.
import {fork} from 'node:child_process';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';

export async function bootAuditServer() {
  const root = resolve(import.meta.dirname, '..');
  await mkdir(resolve(root, 'work'), {recursive: true});
  const dataDir = await mkdtemp(resolve(root, 'work/validation-'));
  const admin = randomBytes(32).toString('hex');
  const child = fork(resolve(root, 'standalone/server.mjs'), [], {
    cwd: root, windowsHide: true, execArgv: [],
    env: {...process.env, RELAY_ADMIN_TOKEN: admin, RELAY_PORT: '0',
      RELAY_HOST: '127.0.0.1', RELAY_DATA_DIR: dataDir,
      RELAY_INFERENCE_CONFIG: '', RELAY_PUBLIC_ORIGIN: '',
      RELAY_SECURE_COOKIE: '0', RELAY_LAUNCH_LOGIN: '1', RELAY_MAINTENANCE_MS: '250', RELAY_SIGNUP_CREDITS: '100'},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => { diagnostics += data; });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(accept => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.once('exit', () => { clearTimeout(timer); accept(); });
      if (child.connected) child.send('relay:shutdown'); else child.kill();
    });
    await rm(dataDir, {recursive: true, force: true});
  };
  const origin = await new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Audit server startup timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Audit server exited during startup: ${code}`)); });
    child.on('message', message => {
      if (message?.type === 'relay:launch-ready') { clearTimeout(timer); accept(message.origin); }
    });
  }).catch(async error => { await close(); throw error; });
  return {origin, admin, dataDir, diagnostics: () => diagnostics, close};
}
