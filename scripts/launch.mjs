import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vite = resolve(projectDir, 'node_modules/vite/bin/vite.js');
const noOpen = process.argv.includes('--no-open');

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error('需要 Node.js 20 或更新版本。');
  process.exit(1);
}
if (!existsSync(vite)) {
  console.error('缺少项目依赖。请先在项目文件夹运行 npm install。');
  process.exit(1);
}

const urlFor = (port) => `http://127.0.0.1:${port}/`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function isOurApp(port) {
  try {
    const response = await fetch(urlFor(port), { signal: AbortSignal.timeout(1200) });
    if (!response.ok || !(await response.text()).includes('<title>Claude · 本地体验环境')) return false;
    const gateway = await fetch(`${urlFor(port)}api/provider`, { signal: AbortSignal.timeout(1200) });
    const state = await gateway.json();
    // Keep the same origin and browser archive when only the saved provider file is damaged.
    return gateway.ok && state.kind !== undefined
      || gateway.status === 500 && String(state.error ?? '').startsWith('读取本机模型配置失败');
  } catch {
    return false;
  }
}

function isBusy(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(false)));
  });
}

async function openBrowser(url) {
  if (noOpen) return true;
  const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', `Start-Process -FilePath '${url}'`] : [url];
  const opened = await new Promise((done) => {
    const browser = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    browser.once('error', () => done(false));
    browser.once('close', (code) => done(code === 0));
  });
  if (!opened) console.warn(`无法自动打开浏览器，请手动访问 ${url}`);
  return opened;
}

async function main() {
  for (let port = 5173; port <= 5183; port++) {
    if (await isOurApp(port)) {
      console.log(`本地体验环境已在运行：${urlFor(port)}`);
      return await openBrowser(urlFor(port)) ? 0 : 1;
    }
    if (await isBusy(port)) continue;

    const server = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: projectDir,
      stdio: 'inherit',
    });
    let exited = false;
    server.once('exit', () => { exited = true; });
    server.once('error', (error) => { console.error(`启动失败：${error.message}`); exited = true; });

    for (let attempt = 0; attempt < 80 && !exited; attempt++) {
      if (await isOurApp(port)) {
        console.log(`\n本地体验环境已就绪：${urlFor(port)}`);
        console.log('保持此窗口打开即可继续游玩；按 Ctrl+C 停止本地服务。');
        await openBrowser(urlFor(port));
        process.on('SIGINT', () => server.kill('SIGINT'));
        process.on('SIGTERM', () => server.kill('SIGTERM'));
        await new Promise((done) => server.once('exit', done));
        return 0;
      }
      await sleep(150);
    }
    if (!exited) server.kill();
    if (await isBusy(port)) {
      console.warn(`端口 ${port} 当前不可用，尝试下一个端口。`);
      continue;
    }
    console.error(`端口 ${port} 的服务未能正常就绪。`);
    return 1;
  }
  console.error('5173–5183 端口都已被占用，请关闭其他本地服务后重试。');
  return 1;
}

process.exitCode = await main();
