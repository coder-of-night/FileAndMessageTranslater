import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ConnectionRejectedError, PeerNode } from '../src/main/network/peer-node';
import { Store } from '../src/main/storage/database';
import { loadIdentity } from '../src/main/storage/identity';
import { connectionRejectionMessage } from '../src/shared/connection-errors';
import selfsigned from 'selfsigned';

async function createPeer(root: string, label: string) {
  const dataDir = join(root, label);
  const store = new Store(dataDir);
  const identity = await loadIdentity(dataDir, label);
  const node = new PeerNode(identity, store, dataDir, 0);
  const address = await node.listen();
  return { node, store, identity, port: address.port, ip: '127.0.0.1' };
}

function eventValue<T>(emitter: PeerNode, event: string, match: (value: T) => boolean = () => true, timeout = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timed out waiting for ${event}`)); }, timeout);
    const listener = (value: T) => {
      if (!match(value)) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(value);
    };
    emitter.on(event, listener);
  });
}

function eventValues<T>(emitter: PeerNode, event: string, count: number, timeout = 30_000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const values: T[] = [];
    const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timed out waiting for ${count} ${event} events`)); }, timeout);
    const listener = (value: T) => {
      values.push(value);
      if (values.length === count) { clearTimeout(timer); emitter.off(event, listener); resolve(values); }
    };
    emitter.on(event, listener);
  });
}

async function closePeers(peers: Array<{ node: PeerNode; store: Store }>, root: string): Promise<void> {
  for (const peer of peers) { await peer.node.close(); peer.store.close(); }
  await new Promise(resolve => setTimeout(resolve, 30));
  await rm(root, { recursive: true, force: true });
}

describe('PeerNode integration', () => {
  it('requires explicit acceptance and persists two-way messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-chat-test-'));
    const a = await createPeer(root, 'a');
    const b = await createPeer(root, 'b');
    try {
      const request = eventValue<{ requestId: string; peerId: string; name: string; fingerprint: string; ip: string }>(b.node, 'incoming-request');
      const pin = await a.node.probeFingerprint(b.ip, b.port);
      const firstConnect = a.node.connect(b.ip, b.port, { fingerprint: pin });
      const incoming = await request;
      expect(structuredClone(incoming)).toEqual({ requestId: incoming.requestId, peerId: a.identity.peerId, name: a.identity.name, fingerprint: a.identity.fingerprint, ip: a.ip });
      await expect(a.node.sendMessage(b.identity.peerId, '不能在对方接受前发送')).rejects.toThrow(/No accepted connection/);
      await expect(a.node.connect(b.ip, b.port, { fingerprint: pin })).rejects.toMatchObject({ reason: 'request-pending' });
      b.node.reject(incoming.requestId);
      await expect(firstConnect).rejects.toMatchObject({ reason: 'declined' });

      const legacyRequest = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const legacyConnect = a.node.connect(b.ip, b.port, { fingerprint: pin });
      const legacy = await legacyRequest;
      const legacySocket = b.node.getPendingRequest(legacy.requestId)!.ws;
      legacySocket.send(JSON.stringify({ type: 'decision', requestId: legacy.requestId, accepted: false, peerId: b.identity.peerId, name: b.identity.name }));
      legacySocket.close();
      await expect(legacyConnect).rejects.toMatchObject({ reason: 'unknown' });
      await new Promise(resolve => setTimeout(resolve, 20));

      const nextRequest = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const pin2 = await a.node.probeFingerprint(b.ip, b.port);
      const connect = a.node.connect(b.ip, b.port, { fingerprint: pin2 });
      const second = await nextRequest;
      b.node.accept(second.requestId);
      const connected = await connect;
      await expect(a.node.connect(b.ip, b.port, { fingerprint: pin2 })).rejects.toMatchObject({ reason: 'already-connected' });
      const inbound = eventValue<{ text: string; peerId: string }>(b.node, 'message', msg => msg.text === '你好，B');
      const ack = eventValue<string>(a.node, 'ack');
      const sentId = await a.node.sendMessage(connected.peerId, '你好，B');
      expect((await inbound).peerId).toBe(a.identity.peerId);
      expect(await ack).toBe(sentId);
      expect(a.store.messages(b.identity.peerId, undefined).at(-1)?.status).toBe('delivered');

      const reply = eventValue<{ text: string }>(a.node, 'message', msg => msg.text === '收到，A');
      await b.node.sendMessage(a.identity.peerId, '收到，A');
      await reply;
      const reopened = new Store(join(root, 'a'));
      expect(reopened.messages(b.identity.peerId, undefined).map(message => message.text)).toEqual(['你好，B', '收到，A']);
      reopened.close();
    } finally { await closePeers([a, b], root); }
  }, 45_000);

  it('explains explicit, duplicate, and legacy rejections without blaming network connectivity', () => {
    expect(new ConnectionRejectedError('declined')).toMatchObject({ reason: 'declined' });
    expect(connectionRejectionMessage('declined')).toContain('对方拒绝');
    expect(connectionRejectionMessage('request-pending')).toContain('已有连接申请');
    expect(connectionRejectionMessage('already-connected')).toContain('已有连接');
    expect(connectionRejectionMessage('unknown')).toContain('旧版本');
  });

  it('keeps one usable connection when both sides accept simultaneous requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-chat-simultaneous-'));
    const a = await createPeer(root, 'a');
    const b = await createPeer(root, 'b');
    try {
      const requestA = eventValue<{ requestId: string }>(a.node, 'incoming-request');
      const requestB = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const [pinA, pinB] = await Promise.all([b.node.probeFingerprint(a.ip, a.port), a.node.probeFingerprint(b.ip, b.port)]);
      const connectionA = a.node.connect(b.ip, b.port, { fingerprint: pinB });
      const connectionB = b.node.connect(a.ip, a.port, { fingerprint: pinA });
      const settled = Promise.allSettled([connectionA, connectionB]);
      const [incomingA, incomingB] = await Promise.all([requestA, requestB]);
      a.node.accept(incomingA.requestId);
      b.node.accept(incomingB.requestId);
      const results = await settled;
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      const inbound = eventValue<{ text: string }>(b.node, 'message', message => message.text === 'still connected');
      await a.node.sendMessage(b.identity.peerId, 'still connected');
      await inbound;
    } finally { await closePeers([a, b], root); }
  }, 45_000);

  it('streams multiple files safely, verifies hashes, and removes cancelled partial files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-chat-files-'));
    const a = await createPeer(root, 'a');
    const b = await createPeer(root, 'b');
    const sources = join(root, 'sources');
    const destination = join(root, 'destination');
    await mkdir(join(sources, 'one'), { recursive: true });
    await mkdir(join(sources, 'two'), { recursive: true });
    await mkdir(destination, { recursive: true });
    const empty = join(sources, 'empty.bin');
    const chinese = join(sources, '你好.txt');
    const duplicateOne = join(sources, 'one', 'same.txt');
    const duplicateTwo = join(sources, 'two', 'same.txt');
    await writeFile(empty, Buffer.alloc(0));
    await writeFile(chinese, '中文文件内容');
    await writeFile(duplicateOne, '第一份');
    await writeFile(duplicateTwo, '第二份');
    try {
      const request = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const pin = await a.node.probeFingerprint(b.ip, b.port);
      const connect = a.node.connect(b.ip, b.port, { fingerprint: pin });
      b.node.accept((await request).requestId);
      const { peerId } = await connect;
      const offerPromise = eventValue<{ transferId: string; files: Array<{ name: string }> }>(b.node, 'file-offer');
      const transferId = await a.node.offerFiles(peerId, [empty, chinese, duplicateOne, duplicateTwo]);
      const offer = await offerPromise;
      const allComplete = eventValues<{ name: string; path: string }>(b.node, 'file-complete', 4);
      await b.node.acceptFiles(transferId, destination);
      const files = await allComplete;
      expect(files).toHaveLength(4);
      const names = await readdir(destination);
      expect(names).toContain('你好.txt');
      expect(names).toContain('same.txt');
      expect(names).toContain('same (1).txt');
      expect(names).toContain('empty.bin');
      for (const name of names) {
        const source = [empty, chinese, duplicateOne, duplicateTwo].find(path => path.endsWith(name) || (name === 'same (1).txt' && path === duplicateTwo));
        if (source) expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(createHash('sha256').update(await readFile(join(destination, name))).digest('hex'));
      }

      const largeFile = join(sources, 'cancel-me.bin');
      await writeFile(largeFile, Buffer.alloc(32 * 1024 * 1024, 7));
      const cancelOffer = eventValue<{ transferId: string }>(b.node, 'file-offer');
      const cancelId = await a.node.offerFiles(peerId, [largeFile]);
      await cancelOffer;
      const progress = eventValue<{ transferId: string; direction: string }>(b.node, 'progress', item => item.transferId === cancelId && item.direction === 'incoming');
      await b.node.acceptFiles(cancelId, destination);
      const firstProgress = await progress;
      a.node.cancel(firstProgress.transferId);
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(await readdir(destination)).not.toContain('cancel-me.bin');
      expect((await readdir(destination)).some(name => name.endsWith('.part'))).toBe(false);

      const changedFile = join(sources, 'changed-during-send.txt');
      await writeFile(changedFile, 'initial');
      const changedOffer = eventValue<{ transferId: string }>(b.node, 'file-offer');
      const changedId = await a.node.offerFiles(peerId, [changedFile]);
      await changedOffer;
      const originalTime = (await stat(changedFile)).mtimeMs;
      await new Promise(resolve => setTimeout(resolve, 20));
      await writeFile(changedFile, 'changed');
      expect((await stat(changedFile)).mtimeMs).not.toBe(originalTime);
      const failedTransfer = eventValue<{ transferId: string }>(a.node, 'error-message');
      await b.node.acceptFiles(changedId, destination);
      await failedTransfer;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readdir(destination)).not.toContain('changed-during-send.txt');
      expect((await readdir(destination)).some(name => name.endsWith('.part'))).toBe(false);
    } finally { await closePeers([a, b], root); }
  }, 90_000);

  it('rejects file data not authorized by an accepted file offer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-chat-auth-'));
    const b = await createPeer(root, 'receiver');
    const attacker = await createPeer(root, 'attacker');
    try {
      const requestPromise = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const socket = new WebSocket(`wss://${b.ip}:${b.port}/peer`, {
        cert: attacker.identity.cert,
        key: attacker.identity.key,
        rejectUnauthorized: false
      });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const requestId = randomUUID();
      socket.send(JSON.stringify({ type: 'request', version: 1, peerId: attacker.identity.peerId, name: 'attacker', requestId }));
      await requestPromise;
      const unauthorizedClose = new Promise<void>((resolve, reject) => {
        socket.on('message', raw => {
          const packet = JSON.parse(raw.toString()) as { type: string };
          if (packet.type === 'decision') {
            socket.send(JSON.stringify({ type: 'file-start', transferId: randomUUID(), fileIndex: 0 }));
          }
        });
        socket.once('close', code => code === 1008 ? resolve() : reject(new Error(`Unexpected close code ${code}`)));
      });
      b.node.accept(requestId);
      await unauthorizedClose;
      socket.terminate();

      await new Promise(resolve => setTimeout(resolve, 20));
      const malformedRequest = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const malformedSocket = new WebSocket(`wss://${b.ip}:${b.port}/peer`, {
        cert: attacker.identity.cert,
        key: attacker.identity.key,
        rejectUnauthorized: false
      });
      await new Promise<void>((resolve, reject) => { malformedSocket.once('open', resolve); malformedSocket.once('error', reject); });
      const malformedRequestId = randomUUID();
      const closedMalformed = new Promise<void>((resolve, reject) => {
        malformedSocket.on('message', raw => {
          if ((JSON.parse(raw.toString()) as { type: string }).type === 'decision') malformedSocket.send('not-json');
        });
        malformedSocket.once('close', code => code === 1008 ? resolve() : reject(new Error(`Unexpected close code ${code}`)));
      });
      malformedSocket.send(JSON.stringify({ type: 'request', version: 1, peerId: attacker.identity.peerId, name: 'attacker', requestId: malformedRequestId }));
      await malformedRequest;
      b.node.accept(malformedRequestId);
      await closedMalformed;
      malformedSocket.terminate();

      await new Promise(resolve => setTimeout(resolve, 20));
      const pathRequest = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const maliciousSocket = new WebSocket(`wss://${b.ip}:${b.port}/peer`, {
        cert: attacker.identity.cert,
        key: attacker.identity.key,
        rejectUnauthorized: false
      });
      await new Promise<void>((resolve, reject) => { maliciousSocket.once('open', resolve); maliciousSocket.once('error', reject); });
      const pathRequestId = randomUUID();
      const transferId = randomUUID();
      const safeFiles = join(root, 'safe-files');
      const receivedFile = eventValue<{ name: string; path: string }>(b.node, 'file-complete');
      const offer = eventValue<{ transferId: string }>(b.node, 'file-offer');
      maliciousSocket.on('message', raw => {
        const packet = JSON.parse(raw.toString()) as { type: string };
        if (packet.type === 'decision') {
          maliciousSocket.send(JSON.stringify({ type: 'file-offer', transferId, files: [{ name: '../../CON.txt', size: 0 }] }));
        } else if (packet.type === 'file-decision') {
          maliciousSocket.send(JSON.stringify({ type: 'file-start', transferId, fileIndex: 0 }));
          maliciousSocket.send(JSON.stringify({ type: 'file-end', transferId, fileIndex: 0, size: 0, sha256: createHash('sha256').digest('hex') }));
        }
      });
      maliciousSocket.send(JSON.stringify({ type: 'request', version: 1, peerId: attacker.identity.peerId, name: 'attacker', requestId: pathRequestId }));
      await pathRequest;
      b.node.accept(pathRequestId);
      await offer;
      await b.node.acceptFiles(transferId, safeFiles);
      expect(await receivedFile).toMatchObject({ name: 'received-file', path: join(await realpath(safeFiles), 'received-file') });
      expect(await readdir(safeFiles)).toEqual(['received-file']);
      maliciousSocket.terminate();
    } finally { await closePeers([b, attacker], root); }
  }, 30_000);

  it('blocks changed TLS identity until the user explicitly reconfirms it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-chat-tofu-'));
    const a = await createPeer(root, 'a');
    const b = await createPeer(root, 'b');
    try {
      const request = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const oldFingerprint = await a.node.probeFingerprint(b.ip, b.port);
      const firstConnect = a.node.connect(b.ip, b.port, { fingerprint: oldFingerprint });
      b.node.accept((await request).requestId);
      const { peerId } = await firstConnect;
      await b.node.close();

      const rotated = await selfsigned.generate([{ name: 'commonName', value: 'LAN Chat Peer' }], { keySize: 2048, days: 3650, algorithm: 'sha256' });
      const rotatedIdentity = {
        ...b.identity,
        key: rotated.private,
        cert: rotated.cert,
        fingerprint: createHash('sha256').update(new X509Certificate(rotated.cert).raw).digest('hex')
      };
      const rotatedNode = new PeerNode(rotatedIdentity, b.store, join(root, 'b'), 0);
      const { port } = await rotatedNode.listen();
      try {
        const newFingerprint = await a.node.probeFingerprint(b.ip, port);
        await expect(a.node.connect(b.ip, port, { fingerprint: newFingerprint, peerId })).rejects.toThrow(/identity changed/i);
        const newRequest = eventValue<{ requestId: string }>(rotatedNode, 'incoming-request');
        const reconnect = a.node.connect(b.ip, port, { fingerprint: newFingerprint, peerId, reconfirm: true });
        rotatedNode.accept((await newRequest).requestId);
        await reconnect;
        expect(a.store.peer(peerId)?.fingerprint).toBe(newFingerprint);
      } finally { await rotatedNode.close(); }
    } finally { await closePeers([a, b], root); }
  }, 45_000);

  it('fails clearly when the listener port is already occupied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-chat-port-'));
    const a = await createPeer(root, 'a');
    const store = new Store(join(root, 'b'));
    const identity = await loadIdentity(join(root, 'b'), 'b');
    const duplicate = new PeerNode(identity, store, join(root, 'b'), a.port);
    try { await expect(duplicate.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' }); }
    finally { await duplicate.close(); store.close(); await closePeers([a], root); }
  });

  it.runIf(process.env.LARGE_TRANSFER_TEST === '1')('streams a real file larger than 1 GiB without linear resident-memory growth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-chat-large-'));
    const a = await createPeer(root, 'a');
    const b = await createPeer(root, 'b');
    const sourcePath = join(root, 'source-1.1GiB.bin');
    const destination = join(root, 'received');
    await mkdir(destination, { recursive: true });
    const size = 1_100 * 1024 * 1024;
    const block = Buffer.alloc(1024 * 1024, 0x5a);
    const handle = await import('node:fs/promises').then(fs => fs.open(sourcePath, 'w'));
    const expectedHash = createHash('sha256');
    try {
      for (let written = 0; written < size; written += block.length) {
        const length = Math.min(block.length, size - written);
        await handle.writeFile(block.subarray(0, length));
        expectedHash.update(block.subarray(0, length));
      }
    } finally { await handle.close(); }
    try {
      const request = eventValue<{ requestId: string }>(b.node, 'incoming-request');
      const pin = await a.node.probeFingerprint(b.ip, b.port);
      const connect = a.node.connect(b.ip, b.port, { fingerprint: pin });
      b.node.accept((await request).requestId);
      const { peerId } = await connect;
      const offerPromise = eventValue<{ transferId: string }>(b.node, 'file-offer');
      const before = process.memoryUsage().rss;
      const samples: number[] = [];
      const sampler = setInterval(() => samples.push(process.memoryUsage().rss), 100);
      sampler.unref();
      const transferId = await a.node.offerFiles(peerId, [sourcePath]);
      await offerPromise;
      const completed = eventValue<{ size: number; path: string }>(b.node, 'file-complete');
      await b.node.acceptFiles(transferId, destination);
      const received = await completed;
      expect(received.size).toBe(size);
      const receivedHash = createHash('sha256');
      for await (const chunk of await import('node:fs').then(fs => fs.createReadStream(received.path))) receivedHash.update(chunk as Buffer);
      expect(receivedHash.digest('hex')).toBe(expectedHash.digest('hex'));
      clearInterval(sampler);
      const peakGrowth = Math.max(0, ...samples) - before;
      console.info(`1.1 GiB transfer peak RSS growth: ${(peakGrowth / 1024 / 1024).toFixed(1)} MiB`);
      expect(peakGrowth).toBeLessThan(256 * 1024 * 1024);
    } finally { await closePeers([a, b], root); }
  }, 600_000);
});
