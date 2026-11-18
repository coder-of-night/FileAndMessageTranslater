import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { PeerNode } from '../src/main/network/peer-node';
import { Store } from '../src/main/storage/database';
import { loadIdentity } from '../src/main/storage/identity';
import { imageUrl } from '../src/shared/history';

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitFor<T>(check: () => Promise<T | undefined>, process: ChildProcess): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (process.exitCode !== null) throw new Error(`Packaged app exited with code ${process.exitCode}`);
    const result = await check();
    if (result !== undefined) return result;
    await delay(100);
  }
  throw new Error('Timed out waiting for packaged app');
}

class Debugger {
  private nextId = 0;
  constructor(private readonly socket: WebSocket) {}
  rpc<T>(method: string, params: object = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.socket.off('message', listener); reject(new Error(`${method} timed out`)); }, 15_000);
      const listener = (raw: Buffer) => {
        const message = JSON.parse(raw.toString()) as { id?: number; result: T; error?: { message: string } };
        if (message.id !== id) return;
        clearTimeout(timer);
        this.socket.off('message', listener);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      this.socket.on('message', listener);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.rpc<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close(): void { this.socket.terminate(); }
}

async function launch() {
  const root = await mkdtemp(join(tmpdir(), 'lan-chat-electron-'));
  const [debugPort, inspectorPort, port] = await Promise.all([unusedPort(), unusedPort(), unusedPort()]);
  const process = spawn(globalThis.process.env.PACKAGED_APP!, [`--user-data-dir=${join(root, 'app')}`, `--remote-debugging-port=${debugPort}`, `--inspect=${inspectorPort}`, `--lan-port=${port}`], { stdio: 'ignore' });
  const debuggers: Debugger[] = [];
  const close = async () => {
    for (const debugger_ of debuggers) debugger_.close();
    process.kill();
    if (process.exitCode === null) await once(process, 'exit');
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  const connect = async (debug: number, type: string) => {
    const url = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debug}/json/list`);
        const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        return targets.find(target => target.type === type)?.webSocketDebuggerUrl;
      } catch { return undefined; }
    }, process);
    const ws = new WebSocket(url);
    await once(ws, 'open');
    const debugger_ = new Debugger(ws);
    debuggers.push(debugger_);
    return debugger_;
  };
  try {
    const renderer = await connect(debugPort, 'page');
    const main = await connect(inspectorPort, 'node');
    await waitFor(async () => (await renderer.evaluate<string>('document.body?.innerText ?? ""')).includes('通讯录') ? true : undefined, process);
    return { root, process, renderer, main, port, close };
  } catch (error) { await close(); throw error; }
}

describe('packaged Electron connection and chat UI', () => {
  it.runIf(Boolean(process.env.PACKAGED_APP))('shows and clears a real incoming request across Electron IPC', async () => {
    const app = await launch();
    let peer: WebSocket | undefined;
    try {
      const identity = await loadIdentity(join(app.root, 'peer'), '测试发起方');
      peer = new WebSocket(`wss://127.0.0.1:${app.port}/peer`, { key: identity.key, cert: identity.cert, rejectUnauthorized: false });
      await once(peer, 'open');
      peer.send(JSON.stringify({ type: 'request', version: 1, peerId: identity.peerId, name: identity.name, requestId: randomUUID() }));
      const displayed = await waitFor(async () => {
        const body = await app.renderer.evaluate<string>('document.body.innerText');
        return body.includes('测试发起方') && body.includes('查看并处理') ? body : undefined;
      }, app.process);
      expect(displayed).toContain('请求连接');
      peer.close();
      await once(peer, 'close');
      await waitFor(async () => !(await app.renderer.evaluate<string>('document.body.innerText')).includes('测试发起方') ? true : undefined, app.process);
    } finally { peer?.terminate(); await app.close(); }
  }, 60_000);

  it.runIf(Boolean(process.env.PACKAGED_APP))('scrolls new messages, sends native dropped files, receives images, previews and saves originals', async () => {
    const app = await launch();
    const { renderer, main, root } = app;
    const store = new Store(join(root, 'peer'));
    const identity = await loadIdentity(join(root, 'peer'), '测试同事');
    const peer = new PeerNode(identity, store, join(root, 'peer'), 0);
    const { port: peerPort } = await peer.listen();
    try {
      // Only this disposable process is instrumented; no test-only production IPC is exposed.
      await main.evaluate(`(() => {
        const electron = process.mainModule.require('electron');
        globalThis.__saveQueue = []; globalThis.__saveRequests = [];
        electron.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
        electron.dialog.showSaveDialog = async (_window, options) => {
          globalThis.__saveRequests.push(options);
          if (!globalThis.__saveQueue.length) throw new Error('Unexpected save dialog');
          const filePath = globalThis.__saveQueue.shift();
          return { canceled: filePath === null, filePath: filePath || '' };
        };
        const buildMenu = electron.Menu.buildFromTemplate;
        electron.Menu.buildFromTemplate = function (template) {
          const menu = buildMenu.call(this, template); globalThis.__lastMenu = menu; return menu;
        };
      })()`);
      expect(await renderer.evaluate('document.querySelector(".contact-modal") === null && document.querySelector(".local-details").open === false')).toBe(true);
      await renderer.evaluate('document.querySelector("[aria-label=\'添加联系人\']").click()');
      expect(await renderer.evaluate('document.querySelector(".contact-modal") !== null')).toBe(true);
      await renderer.evaluate('document.querySelector(".contact-modal [aria-label=\'关闭\']").click()');
      await renderer.evaluate(`window.desktop.addContact('127.0.0.1', ${peerPort}, '测试同事')`);

      const fingerprint = await peer.probeFingerprint('127.0.0.1', app.port);
      const connecting = peer.connect('127.0.0.1', app.port, { fingerprint });
      await waitFor(async () => (await renderer.evaluate<string>('document.body.innerText')).includes('查看并处理') ? true : undefined, app.process);
      await renderer.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "查看并处理").click()');
      const connected = await connecting;
      await waitFor(async () => (await renderer.evaluate<string>('document.body.innerText')).includes('已建立加密连接') ? true : undefined, app.process);

      for (let index = 0; index < 40; index++) await peer.sendMessage(connected.peerId, `滚动测试消息 ${index}`);
      await waitFor(async () => (await renderer.evaluate<string>('document.body.innerText')).includes('滚动测试消息 39') ? true : undefined, app.process);
      await renderer.evaluate('document.querySelector(".messages").scrollTop = 0');
      expect(await renderer.evaluate('document.querySelector(".messages").scrollHeight > document.querySelector(".messages").clientHeight + 100')).toBe(true);
      await peer.sendMessage(connected.peerId, '新消息必须自动滚动到底部');
      await waitFor(async () => await renderer.evaluate<boolean>('document.body.innerText.includes("新消息必须自动滚动到底部") && (() => { const list = document.querySelector(".messages"); return list.scrollHeight - list.clientHeight - list.scrollTop < 2; })()') ? true : undefined, app.process);
      expect(await renderer.evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent.includes("发送文件"))')).toBe(false);

      const dataUrl = await renderer.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width=320; canvas.height=180;
        const ctx=canvas.getContext('2d'); ctx.fillStyle='#20866d';ctx.fillRect(0,0,320,180);
        ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('LAN image preview',40,95);
        return canvas.toDataURL('image/png');
      })()`);
      const image = join(root, '聊天图片.png');
      const bytes = Buffer.from(dataUrl.split(',')[1]!, 'base64');
      await writeFile(image, bytes);
      const incoming = await peer.offerFiles(connected.peerId, [image]);
      await waitFor(async () => store.fileSummary(`${incoming}:0`)?.status === 'sent' ? true : undefined, app.process);
      await waitFor(async () => await renderer.evaluate<boolean>('!!document.querySelector(".image-button img")?.naturalWidth') ? true : undefined, app.process);
      expect(await main.evaluate('globalThis.__saveRequests.length')).toBe(0);
      await renderer.evaluate('document.querySelector(".image-button").click()');
      await waitFor(async () => await renderer.evaluate<boolean>('document.querySelector(".image-preview img")?.naturalWidth === 320') ? true : undefined, app.process);
      await renderer.rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await waitFor(async () => await renderer.evaluate<boolean>('document.querySelector(".image-preview") === null') ? true : undefined, app.process);

      const imageSaved = join(root, 'saved-original.png');
      await main.evaluate(`globalThis.__saveQueue.push(${JSON.stringify(imageSaved)})`);
      await renderer.evaluate('document.querySelector(".image-button").dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,cancelable:true}))');
      await waitFor(async () => await main.evaluate<boolean>('Boolean(globalThis.__lastMenu)') ? true : undefined, app.process);
      await main.evaluate('globalThis.__lastMenu.closePopup(); globalThis.__lastMenu.items[0].click()');
      await waitFor(async () => { try { return (await readFile(imageSaved)).equals(bytes) ? true : undefined; } catch { return undefined; } }, app.process);
      expect(await readFile(imageSaved)).toEqual(bytes);

      const existing = join(root, 'existing.png');
      await writeFile(existing, 'must never be overwritten');
      await main.evaluate(`globalThis.__saveQueue.push(${JSON.stringify(existing)}); globalThis.__lastMenu = null`);
      await renderer.evaluate('document.querySelector(".image-button").dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,cancelable:true}))');
      await waitFor(async () => await main.evaluate<boolean>('Boolean(globalThis.__lastMenu)') ? true : undefined, app.process);
      await main.evaluate('globalThis.__lastMenu.closePopup(); globalThis.__lastMenu.items[0].click()');
      await waitFor(async () => (await renderer.evaluate<string>('document.body.innerText')).includes('不会覆盖已有文件') ? true : undefined, app.process);
      expect(await readFile(existing, 'utf8')).toBe('must never be overwritten');
      await renderer.evaluate('document.querySelector(".notice button").click()');

      const destination = join(root, 'dropped');
      await mkdir(destination);
      let droppedId: string | undefined;
      peer.on('file-offer', offer => { droppedId = offer.transferId; void peer.acceptFiles(offer.transferId, destination); });
      const point = await renderer.evaluate<{ x: number; y: number }>('(() => { const box = document.querySelector(".chat-pane").getBoundingClientRect(); return {x:box.x + box.width/2,y:box.y + box.height/2}; })()');
      const drop = async (path: string) => {
        for (const type of ['dragEnter', 'dragOver', 'drop']) await renderer.rpc('Input.dispatchDragEvent', { type, ...point, data: { items: [], files: [path], dragOperationsMask: 1 } });
      };
      await drop(image);
      await waitFor(async () => droppedId && store.fileSummary(`${droppedId}:0`)?.status === 'received' ? true : undefined, app.process);
      expect(await readFile(join(destination, '聊天图片.png'))).toEqual(bytes);
      await waitFor(async () => await renderer.evaluate<boolean>('document.querySelectorAll(".image-button img").length === 2 && Array.from(document.querySelectorAll(".image-button img")).every(image => image.naturalWidth > 0)') ? true : undefined, app.process);

      const normal = join(root, 'normal.txt');
      await writeFile(normal, 'ordinary file bytes');
      droppedId = undefined;
      await drop(normal);
      await waitFor(async () => droppedId && store.fileSummary(`${droppedId}:0`)?.status === 'received' ? true : undefined, app.process);
      expect(await readFile(join(destination, 'normal.txt'), 'utf8')).toBe('ordinary file bytes');

      const normalSaved = join(root, 'chosen-name.txt');
      await main.evaluate(`globalThis.__saveQueue.push(${JSON.stringify(normalSaved)}, null)`);
      const accepted = await peer.offerFiles(connected.peerId, [normal]);
      await waitFor(async () => store.fileSummary(`${accepted}:0`)?.status === 'sent' ? true : undefined, app.process);
      expect(await readFile(normalSaved, 'utf8')).toBe('ordinary file bytes');
      const skipped = await peer.offerFiles(connected.peerId, [normal]);
      await waitFor(async () => store.fileSummary(`${skipped}:0`)?.status === 'cancelled' ? true : undefined, app.process);
      expect(await main.evaluate('globalThis.__saveRequests.length')).toBe(4);

      const brokenImage = join(root, 'broken.png');
      await writeFile(brokenImage, bytes.subarray(0, 33));
      const broken = await peer.offerFiles(connected.peerId, [brokenImage]);
      await waitFor(async () => store.fileSummary(`${broken}:0`)?.status === 'failed' ? true : undefined, app.process);
      expect(await renderer.evaluate('document.querySelectorAll(".image-button").length')).toBe(2);

      expect(await main.evaluate(`process.mainModule.require('electron').net.fetch(${JSON.stringify(imageUrl(`${incoming}:0`))}).then(response => response.status)`)).toBe(200);
      expect(await main.evaluate(`process.mainModule.require('electron').net.fetch('lan-image://other/anything').then(response => response.status)`)).toBe(403);
      expect(await main.evaluate(`process.mainModule.require('electron').net.fetch('lan-image://image/${randomUUID()}:0').then(response => response.status)`)).toBe(404);
      if (process.env.UX_SCREENSHOT) {
        await renderer.evaluate('document.querySelector(".notice button")?.click(); document.querySelector(".image-button").closest("article").scrollIntoView({block:"start"})');
        const screenshot = await renderer.rpc<{ data: string }>('Page.captureScreenshot', { format: 'png' });
        await writeFile(process.env.UX_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
      }
    } finally { await peer.close(); store.close(); await app.close(); }
  }, 120_000);
});
