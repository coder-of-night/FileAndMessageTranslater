import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { PeerNode } from '../src/main/network/peer-node';
import { Store } from '../src/main/storage/database';
import { loadIdentity } from '../src/main/storage/identity';
import { AutomaticReceiver } from '../src/main/transfer/auto-receiver';
import { inspectRaster } from '../src/main/transfer/images';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function until(check: () => boolean, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for automatic transfer'); await delay(10); }
}
async function pair() {
  const root = await mkdtemp(join(tmpdir(), 'lan-auto-'));
  const make = async (label: string) => {
    const directory = join(root, label);
    const store = new Store(directory);
    const identity = await loadIdentity(directory, label);
    const node = new PeerNode(identity, store, directory, 0);
    const { port } = await node.listen();
    return { directory, store, identity, node, port };
  };
  const a = await make('a');
  const b = await make('b');
  let requestId: string | undefined;
  b.node.once('incoming-request', request => { requestId = request.requestId; });
  const fingerprint = await a.node.probeFingerprint('127.0.0.1', b.port);
  const connecting = a.node.connect('127.0.0.1', b.port, { fingerprint });
  await until(() => Boolean(requestId));
  b.node.accept(requestId!);
  await connecting;
  return { root, a, b, close: async () => {
    await a.node.close(); await b.node.close(); a.store.close(); b.store.close();
    await rm(root, { force: true, recursive: true });
  } };
}

describe('automatic receive and persistent file history', () => {
  it('receives images without a dialog, saves ordinary files at the chosen path, and skips cancelled files in a mixed batch', async () => {
    const peers = await pair();
    const { root, a, b } = peers;
    const image = join(root, '图片.png');
    const text = join(root, 'document.txt');
    const skip = join(root, 'skip.txt');
    const saved = join(root, 'chosen', 'renamed.txt');
    await writeFile(image, png); await writeFile(text, 'document bytes'); await writeFile(skip, 'skip');
    const choose = vi.fn(async (name: string) => name === 'document.txt' ? saved : null);
    const notify = vi.fn();
    const receiver = new AutomaticReceiver(b.node, b.store, b.directory, { savePath: choose, thumbnail: copyFile, notify });
    const sender = new AutomaticReceiver(a.node, a.store, a.directory, { savePath: async () => null, thumbnail: copyFile, notify });
    try {
      const id = await sender.send(b.identity.peerId, [image, text, skip]);
      await until(() => a.store.file(`${id}:0`)?.status === 'sent' && a.store.file(`${id}:1`)?.status === 'sent');
      expect(choose.mock.calls.map(call => call[0])).toEqual(['document.txt', 'skip.txt']);
      expect(b.store.fileSummary(`${id}:0`)).toMatchObject({ image: true, name: '图片.png', status: 'received' });
      expect(b.store.fileSummary(`${id}:1`)).toMatchObject({ name: 'renamed.txt', status: 'received' });
      expect(b.store.fileSummary(`${id}:2`)).toMatchObject({ status: 'cancelled' });
      expect(a.store.fileSummary(`${id}:2`)).toMatchObject({ status: 'cancelled' });
      expect(await readFile(saved, 'utf8')).toBe('document bytes');
      expect(await readFile(b.store.file(`${id}:0`)!.savedPath!)).toEqual(png);
      expect(a.store.fileSummary(`${id}:0`)).toMatchObject({ image: true, name: '图片.png', direction: 'outgoing' });
      await writeFile(image, 'source changed after send');
      expect(await readFile(a.store.file(`${id}:0`)!.savedPath!)).toEqual(png);
      expect(notify).not.toHaveBeenCalled();
      const reopened = new Store(b.directory);
      expect(reopened.history(a.identity.peerId).filter(entry => entry.kind === 'file')).toHaveLength(3);
      expect(reopened.fileSummary(`${id}:0`)?.image).toBe(true);
      reopened.close();
    } finally { await sender.close(); await receiver.close(); await peers.close(); }
  });

  it('rejects spoofed images, handles save failures and disconnects without completed partial files', async () => {
    const peers = await pair();
    const { root, a, b } = peers;
    const spoof = join(root, 'fake.png');
    await writeFile(spoof, '<svg onload="bad"></svg>');
    const destination = join(root, 'receive');
    await mkdir(destination);
    const notify = vi.fn();
    const errors = vi.fn();
    b.node.on('error-message', errors);
    let failedDestination = false;
    const receiver = new AutomaticReceiver(b.node, b.store, b.directory, {
      savePath: async name => failedDestination ? join(root, 'not-a-folder', name) : join(destination, name),
      thumbnail: copyFile, notify
    });
    try {
      const invalid = await a.node.offerFiles(b.identity.peerId, [spoof]);
      await until(() => b.store.file(`${invalid}:0`)?.status === 'failed');
      await until(() => b.store.tempFiles().length === 0);
      expect(b.store.file(`${invalid}:0`)?.image).toBe(false);
      expect((await readdir(join(b.directory, 'images'))).some(name => name.endsWith('.part'))).toBe(false);
      expect(errors).toHaveBeenCalled();

      const normal = join(root, 'normal.bin');
      await writeFile(normal, Buffer.alloc(32 * 1024 * 1024, 17));
      failedDestination = true;
      await writeFile(join(root, 'not-a-folder'), 'blocks directory creation');
      const failed = await a.node.offerFiles(b.identity.peerId, [normal]);
      await until(() => b.store.file(`${failed}:0`)?.status === 'cancelled');
      failedDestination = false;

      let interrupted = false;
      const stop = ({ direction }: { direction: string }) => {
        if (direction === 'incoming' && !interrupted) { interrupted = true; b.node.disconnect(a.identity.peerId); }
      };
      b.node.on('progress', stop);
      const disconnect = await a.node.offerFiles(b.identity.peerId, [normal]);
      await until(() => ['failed', 'cancelled'].includes(b.store.file(`${disconnect}:0`)?.status ?? ''));
      await until(() => b.store.tempFiles().length === 0);
      expect(await readdir(destination)).toEqual([]);
      b.node.off('progress', stop);
    } finally { await receiver.close(); await peers.close(); }
  });

  it('checks actual image bytes and rejects oversized decoded dimensions before decoding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-image-'));
    try {
      const valid = join(root, 'valid.png');
      await writeFile(valid, png);
      expect(await inspectRaster(valid)).toMatchObject({ width: 1, height: 1, mediaType: 'image/png' });
      const bomb = Buffer.from(png);
      bomb.writeUInt32BE(50_000, 16);
      await writeFile(join(root, 'bomb.png'), bomb);
      await expect(inspectRaster(join(root, 'bomb.png'))).rejects.toThrow(/尺寸过大/);
      await writeFile(join(root, 'svg.png'), '<svg width="20" height="20"></svg>');
      await expect(inspectRaster(join(root, 'svg.png'))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('cleans images cancelled during thumbnail creation and falls back to saving when the cache is full', async () => {
    const peers = await pair();
    const { a, b, root } = peers;
    const image = join(root, 'photo.png');
    await writeFile(image, png);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let validating = false;
    const savePath = vi.fn(async () => join(root, 'fallback.png'));
    const notify = vi.fn();
    const receiver = new AutomaticReceiver(b.node, b.store, b.directory, {
      savePath, notify, thumbnail: async (source, target) => { validating = true; await gate; await copyFile(source, target); }
    });
    try {
      const id = await a.node.offerFiles(b.identity.peerId, [image]);
      await until(() => validating);
      const cancelled = b.node.cancel(id);
      release();
      await cancelled;
      expect(await readdir(join(b.directory, 'images'))).toEqual([]);
      expect(b.store.fileSummary(`${id}:0`)?.status).toBe('cancelled');
      expect(savePath).not.toHaveBeenCalled();

      const quota = await open(join(b.directory, 'images', 'cache-budget'), 'w');
      await quota.truncate(512 * 1024 * 1024);
      await quota.close();
      const fallback = await a.node.offerFiles(b.identity.peerId, [image]);
      await until(() => a.store.fileSummary(`${fallback}:0`)?.status === 'sent');
      expect(savePath).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('缓存限制'));
      expect(b.store.fileSummary(`${fallback}:0`)).toMatchObject({ image: false, status: 'received' });
      expect(await readFile(join(root, 'fallback.png'))).toEqual(png);
    } finally { release(); await receiver.close(); await peers.close(); }
  });

  it('migrates existing SQLite history and pages entries with identical timestamps without losing records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-migrate-'));
    const legacy = new DatabaseSync(join(root, 'lan-chat.sqlite'));
    legacy.exec(`CREATE TABLE files (id TEXT PRIMARY KEY,peer_id TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,result TEXT NOT NULL,saved_path TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY,peer_id TEXT NOT NULL,direction TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL);
      INSERT INTO files VALUES('old-file','peer','old.txt',10,'received',NULL,20);
      INSERT INTO messages VALUES('old-text','peer','incoming','历史记录',10,'received');`);
    legacy.close();
    const store = new Store(root);
    try {
      for (let index = 0; index < 105; index++) store.saveMessage({ id: String(index).padStart(3, '0'), peerId: 'peer', direction: 'incoming', text: String(index), createdAt: 30, status: 'received' });
      const first = store.history('peer');
      const second = store.history('peer', { createdAt: first[0]!.createdAt, id: first[0]!.id });
      expect(first).toHaveLength(100);
      expect(second).toHaveLength(7);
      expect(new Set([...second, ...first].map(entry => entry.id)).size).toBe(107);
      expect(store.fileSummary('old-file')).toMatchObject({ name: 'old.txt', direction: 'incoming', status: 'received', image: false });
      expect(second[0]).toMatchObject({ kind: 'text', text: '历史记录' });
    } finally { store.close(); await rm(root, { force: true, recursive: true }); }
  });
});
