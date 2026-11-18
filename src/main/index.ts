import { app, BrowserWindow, dialog, nativeImage, protocol } from 'electron';
import { basename, dirname, join, relative } from 'node:path';
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { PeerNode } from './network/peer-node';
import { Store } from './storage/database';
import { loadIdentity } from './storage/identity';
import { registerIpc } from './ipc';
import { AutomaticReceiver } from './transfer/auto-receiver';

let mainWindow: BrowserWindow | undefined;
let node: PeerNode | undefined;
let store: Store | undefined;
let receiver: AutomaticReceiver | undefined;

protocol.registerSchemesAsPrivileged([{ scheme: 'lan-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

async function createWindow(): Promise<void> {
  const dataDir = app.getPath('userData');
  store = new Store(dataDir);
  for (const tempPath of store.tempFiles()) {
    if (/^\.lan-chat-[0-9a-f-]{36}-\d+\.part$/i.test(basename(tempPath))) {
      await rm(tempPath, { force: true });
      store.forgetTemp(tempPath);
    }
  }
  const identity = await loadIdentity(dataDir, hostname() || '本机');
  const portArgument = app.commandLine.getSwitchValue('lan-port');
  const port = portArgument ? Number(portArgument) : 45873;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('监听端口必须为 1–65535 的整数');
  node = new PeerNode(identity, store, dataDir, port);
  let info: { addresses: string[]; port: number };
  try { info = await node.listen(); }
  catch (error) {
    await dialog.showErrorBox('无法启动局域网监听', `端口 ${port} 可能已被占用，或防火墙/系统策略阻止监听。\n\n${error instanceof Error ? error.message : String(error)}`);
    app.quit();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    title: '局域网消息与文件',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  receiver = new AutomaticReceiver(node, store, dataDir, {
    savePath: async (name, size) => {
      const result = await dialog.showSaveDialog(mainWindow!, { title: `保存收到的文件（${(size / 1024 / 1024).toFixed(1)} MiB）`, defaultPath: name });
      return result.canceled ? null : result.filePath ?? null;
    },
    thumbnail: async (path, destination) => {
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) throw new Error('图片解码失败');
      const size = image.getSize();
      const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
      const preview = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }).toPNG();
      if (preview.length > 12 * 1024 * 1024) throw new Error('图片预览超出资源限制');
      await writeFile(destination, preview, { flag: 'wx', mode: 0o600 });
    },
    notify: message => { if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('peer:event', { event: 'error-message', payload: message }); }
  });
  protocol.handle('lan-image', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'image' || request.method !== 'GET') return new Response(null, { status: 403 });
      const id = decodeURIComponent(url.pathname.slice(1));
      if (!/^[0-9a-f-]{36}:\d{1,2}$/i.test(id)) return new Response(null, { status: 404 });
      const file = store!.file(id);
      if (!file?.image || !file.thumbnailPath) return new Response(null, { status: 404 });
      const path = await realpath(file.thumbnailPath);
      if (relative(await realpath(join(dataDir, 'images')), dirname(path)) !== '') return new Response(null, { status: 403 });
      if ((await stat(path)).size > 12 * 1024 * 1024) return new Response(null, { status: 413 });
      return new Response(new Uint8Array(await readFile(path)), { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' } });
    } catch (error) {
      console.error('Unable to load cached image', error);
      return new Response(null, { status: 404 });
    }
  });
  registerIpc(mainWindow, node, store, identity, info, receiver);
  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

app.whenReady().then(createWindow).catch(error => {
  dialog.showErrorBox('启动失败', error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
let completingQuit = false;
app.on('before-quit', event => {
  if (completingQuit) return;
  event.preventDefault();
  completingQuit = true;
  void (async () => {
    try { await node?.close(); await receiver?.close(); }
    catch (error) { dialog.showErrorBox('关闭连接时出错', error instanceof Error ? error.message : String(error)); }
    finally { store?.close(); app.quit(); }
  })();
});
