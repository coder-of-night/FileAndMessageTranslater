import { ipcMain, dialog, Menu, type BrowserWindow } from 'electron';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { AutomaticReceiver } from '../transfer/auto-receiver';
import { safeName } from '../transfer/filenames';
import { isIP } from 'node:net';
import { z } from 'zod';
import { ConnectionRejectedError, type PeerNode } from '../network/peer-node';
import type { Store } from '../storage/database';
import type { Identity } from '../storage/identity';

const contactInput = z.object({ ip: z.string().refine(value => isIP(value) === 4, '请输入有效的 IPv4 地址'), port: z.number().int().min(1).max(65535), name: z.string().trim().min(1).max(80) });
const event = (window: BrowserWindow, name: string) => (payload: unknown) => { if (!window.isDestroyed()) window.webContents.send('peer:event', { event: name, payload }); };

export function registerIpc(window: BrowserWindow, node: PeerNode, store: Store, identity: Identity, info: { addresses: string[]; port: number }, receiver: AutomaticReceiver): void {
  const connecting = new Set<string>();
  const forward = ['incoming-request', 'identity-change', 'request-expired', 'connected', 'disconnected', 'message', 'ack', 'file-history', 'file-result', 'progress', 'transfer-ended', 'error-message'];
  for (const name of forward) node.on(name, event(window, name));
  node.on('identity-change', async (details: { peerId: string; fingerprint: string; ip: string }) => {
    const answer = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '对端身份已变化',
      message: `联系人 ${details.peerId} 的 TLS 指纹发生变化。请通过可信渠道核对新指纹后再继续。`,
      detail: `IP: ${details.ip}\nSHA-256: ${details.fingerprint}`,
      buttons: ['已通过可信渠道核对，更新信任', '暂不信任'],
      defaultId: 1,
      cancelId: 1
    });
    if (answer.response === 0) store.bindContact(details.ip, details.peerId, details.fingerprint, details.peerId);
  });

  ipcMain.handle('app:info', () => ({ name: identity.name, peerId: identity.peerId, fingerprint: identity.fingerprint, ...info }));
  ipcMain.handle('contacts:list', () => store.contacts());
  ipcMain.handle('contacts:add', (_event, input) => { const data = contactInput.parse(input); store.addContact(data.ip, data.port, data.name); return store.contacts(); });
  ipcMain.handle('contacts:edit', (_event, input) => {
    const data = z.object({ id: z.number().int().positive(), ...contactInput.shape }).parse(input);
    store.editContact(data.id, data.ip, data.port, data.name);
    return store.contacts();
  });
  ipcMain.handle('contacts:delete', (_event, id) => { store.deleteContact(z.number().int().positive().parse(id)); return store.contacts(); });
  ipcMain.handle('peer:connect', async (_event, raw) => {
    const input = z.object({ ip: contactInput.shape.ip, port: contactInput.shape.port, name: contactInput.shape.name }).parse(raw);
    const key = `${input.ip}:${input.port}`;
    if (connecting.has(key)) return { ok: false as const, reason: 'request-pending' as const };
    connecting.add(key);
    try {
      const fingerprint = await node.probeFingerprint(input.ip, input.port);
      const peer = store.contacts().find(contact => contact.ip === input.ip);
      const identityChanged = Boolean(peer?.fingerprint && peer.fingerprint !== fingerprint);
      const answer = await dialog.showMessageBox(window, {
        type: identityChanged ? 'warning' : 'question',
        title: identityChanged ? '请核对对端身份变化' : '确认对端身份',
        message: `正在连接 ${input.name}（${input.ip}:${input.port}）`,
        detail: `SHA-256 指纹：\n${fingerprint}\n\n首次连接采用 TOFU。请通过可信渠道核对指纹；如果指纹改变，不要仅凭 IP 或名称继续。`,
        buttons: identityChanged ? ['已核对并重新信任', '取消'] : ['信任并发送连接申请', '取消'],
        defaultId: 1,
        cancelId: 1
      });
      if (answer.response !== 0) return { ok: false as const, reason: 'cancelled' as const };
      const result = await node.connect(input.ip, input.port, { fingerprint, peerId: peer?.peerId ?? undefined, reconfirm: identityChanged });
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof ConnectionRejectedError) return { ok: false as const, reason: error.reason };
      throw error;
    } finally { connecting.delete(key); }
  });
  ipcMain.handle('peer:accept', async (_event, requestId) => {
    const request = z.string().uuid().parse(requestId);
    const pending = node.getPendingRequest(request);
    if (!pending) throw new Error('连接申请已过期');
    const answer = await dialog.showMessageBox(window, {
      type: 'question',
      title: '收到连接申请',
      message: `${pending.name}（${pending.ip}）请求连接`,
      detail: `TLS SHA-256 指纹：\n${pending.fingerprint}\n\n自报名称不能证明真实身份。请先核验指纹。接受后可双向聊天，图片将自动缓存并显示，普通文件会直接询问保存位置。`,
      buttons: ['接受', '拒绝'],
      defaultId: 1,
      cancelId: 1
    });
    if (answer.response === 0) node.accept(request);
    else node.reject(request);
  });
  ipcMain.handle('peer:reject', (_event, id) => node.reject(z.string().uuid().parse(id)));
  ipcMain.handle('chat:send', (_event, raw) => { const input = z.object({ peerId: z.string().uuid(), text: z.string().trim().min(1).max(16_000) }).parse(raw); return node.sendMessage(input.peerId, input.text); });
  ipcMain.handle('chat:history', (_event, raw) => {
    const input = z.object({ peerId: z.string().uuid(), before: z.number().int().optional() }).parse(raw);
    return store.messages(input.peerId, input.before);
  });
  ipcMain.handle('chat:timeline', (_event, raw) => {
    const input = z.object({ peerId: z.string().uuid(), before: z.object({ createdAt: z.number().int(), id: z.string().min(1).max(100) }).optional() }).parse(raw);
    return store.history(input.peerId, input.before);
  });
  ipcMain.handle('files:drop', (_event, raw) => {
    const input = z.object({ peerId: z.string().uuid(), paths: z.array(z.string().min(1).max(32768)).min(1).max(100) }).parse(raw);
    return receiver.send(input.peerId, input.paths);
  });
  ipcMain.handle('images:menu', (_event, raw) => {
    const id = z.string().regex(/^[0-9a-f-]{36}:\d{1,2}$/i).parse(raw);
    const file = store.file(id);
    if (!file?.image || !file.savedPath || !['sent', 'received'].includes(file.status)) throw new Error('图片不可用或尚未传输完成');
    Menu.buildFromTemplate([{ label: '图片另存为…', click: async () => {
      try {
        const result = await dialog.showSaveDialog(window, { title: '保存图片', defaultPath: safeName(file.name) });
        if (result.canceled || !result.filePath) return;
        await copyFile(file.savedPath!, result.filePath, constants.COPYFILE_EXCL);
        event(window, 'saved-image')({ name: file.name });
      } catch (error) { event(window, 'error-message')(`保存图片失败（不会覆盖已有文件）：${error instanceof Error ? error.message : String(error)}`); }
    } }]).popup({ window });
  });
  ipcMain.handle('files:cancel', (_event, id) => node.cancel(z.string().uuid().parse(id)));
  ipcMain.handle('peer:disconnect', (_event, id) => node.disconnect(z.string().uuid().parse(id)));
}
