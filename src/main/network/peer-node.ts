import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createServer, type Server as HttpsServer } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import { WebSocket, WebSocketServer } from 'ws';
import { packetSchema, type Packet } from '../../shared/protocol';
import type { Identity } from '../storage/identity';
import type { Store } from '../storage/database';
import type { ConnectionRejection } from '../../shared/api';
import { safeName } from '../transfer/filenames';

export type FileDestination = {
  directory: string;
  name?: string;
  validate?: (temporaryPath: string) => Promise<{ mediaType: string; thumbnailPath: string }>;
};

export class ConnectionRejectedError extends Error {
  constructor(readonly reason: ConnectionRejection) {
    super('Connection request was declined');
    this.name = 'ConnectionRejectedError';
  }
}

type Pending = { ws: WebSocket; peerId: string; fingerprint: string; ip: string; name: string; requestId: string };
type Session = { ws: WebSocket; peerId: string; fingerprint: string; name: string; ip: string; incoming: boolean; approved: boolean; lastHeartbeat: number };
type OutgoingFile = { path: string; name: string; size: number; modifiedAt: number };
type OutgoingTransfer = { session: Session; files: OutgoingFile[]; accepted: boolean; indices?: number[]; cancelled: boolean; completed: Set<number> };
type IncomingTransfer = {
  session: Session; files: Array<{ name: string; size: number }>; destinations?: Array<FileDestination | null>;
  completed: Set<number>; cancelled: boolean;
  opening?: Promise<void>;
  validating?: Promise<{ mediaType: string; thumbnailPath: string } | undefined>;
  finalizing?: Promise<void>;
  writes: Map<number, { path: string; handle: Awaited<ReturnType<typeof open>>; size: number; hash: ReturnType<typeof createHash> }>;
};
const CHUNK = 256 * 1024;
const uuid = () => randomUUID();
const fingerprintOf = (cert: string | Buffer) => createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
const decodePacket = (raw: string) => {
  try { return packetSchema.safeParse(JSON.parse(raw)); }
  catch { return null; }
};

export class PeerNode extends EventEmitter {
  private server?: HttpsServer;
  private wss?: WebSocketServer;
  private readonly pending = new Map<string, Pending>();
  private readonly sessions = new Map<string, Session>();
  private readonly incomingTransfers = new Map<string, IncomingTransfer>();
  private readonly outgoingTransfers = new Map<string, OutgoingTransfer>();
  private readonly sessionChains = new WeakMap<WebSocket, Promise<void>>();
  private readonly pendingChunkAcks = new Map<string, () => void>();
  private readonly cancellations = new Map<string, Promise<void>>();
  constructor(private readonly identity: Identity, private readonly store: Store, private readonly dataDir: string, private readonly port = 45873) { super(); }

  async listen(): Promise<{ port: number; addresses: string[] }> {
    this.server = createServer({ key: this.identity.key, cert: this.identity.cert, requestCert: true, rejectUnauthorized: false });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/peer') { socket.destroy(); return; }
      this.wss!.handleUpgrade(req, socket, head, ws => this.handleSocket(ws, req.socket.remoteAddress ?? ''));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '0.0.0.0', () => { this.server!.off('error', reject); resolve(); });
    });
    setInterval(() => {
      for (const session of this.sessions.values()) {
        if (Date.now() - session.lastHeartbeat > 45_000) session.ws.close(1001, 'heartbeat timeout');
        else if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ type: 'heartbeat', at: Date.now() }));
      }
    }, 15_000).unref();
    const addresses = Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address));
    return { port: (this.server.address() as { port: number }).port, addresses };
  }

  private handleSocket(ws: WebSocket, rawIp: string): void {
    const ip = rawIp.replace(/^::ffff:/, '');
    const cert = (ws as WebSocket & { _socket: TLSSocket })._socket.getPeerCertificate();
    const fingerprint = cert?.raw ? fingerprintOf(cert.raw) : '';
    let remotePeerId: string | undefined;
    let session: Session | undefined;
    let buffered = 0;
    let packetChain = Promise.resolve();
    ws.on('message', raw => {
      buffered += 1;
      if (buffered > 10_000) { ws.close(1008, 'too many messages'); return; }
      packetChain = packetChain.then(async () => {
        try {
          const parsed = decodePacket(raw.toString());
          if (!parsed || !parsed.success) { ws.close(1008, 'invalid protocol packet'); return; }
          const packet = parsed.data;
          if (!remotePeerId) {
            if (packet.type !== 'request' || !fingerprint || packet.peerId === this.identity.peerId || this.pending.size >= 32) { ws.close(1008, 'connection request required'); return; }
            remotePeerId = packet.peerId;
            const existing = this.sessions.get(remotePeerId);
            if (existing) {
              ws.send(JSON.stringify({ type: 'decision', requestId: packet.requestId, accepted: false, reason: 'already-connected', peerId: this.identity.peerId, name: this.identity.name }));
              setTimeout(() => ws.close(), 100).unref();
              return;
            }
            if ([...this.pending.values()].some(pending => pending.peerId === remotePeerId)) {
              ws.send(JSON.stringify({ type: 'decision', requestId: packet.requestId, accepted: false, reason: 'request-pending', peerId: this.identity.peerId, name: this.identity.name }));
              setTimeout(() => ws.close(), 100).unref();
              return;
            }
            const bound = this.store.peer(remotePeerId);
            if (bound && bound.fingerprint !== fingerprint) {
              this.emit('identity-change', { peerId: remotePeerId, oldFingerprint: bound.fingerprint, fingerprint, ip });
              ws.close(1008, 'identity changed');
              return;
            }
            const item = { ws, peerId: remotePeerId, fingerprint, ip, name: packet.name, requestId: packet.requestId };
            this.pending.set(packet.requestId, item);
            setTimeout(() => {
              if (this.pending.get(packet.requestId) === item) {
                this.pending.delete(packet.requestId);
                ws.close(1008, 'request expired');
                this.emit('request-expired', { requestId: packet.requestId });
              }
            }, 90_000).unref();
            this.emit('incoming-request', { peerId: item.peerId, fingerprint: item.fingerprint, ip: item.ip, name: item.name, requestId: item.requestId });
            return;
          }
          if (!session) {
            const approved = this.sessions.get(remotePeerId);
            if (approved && approved.ws === ws) { await this.onPacket(approved, packet); return; }
            if (packet.type !== 'decision' || packet.peerId !== remotePeerId || packet.requestId !== (ws as WebSocket & { requestId?: string }).requestId) {
              const reqId = (ws as WebSocket & { requestId?: string }).requestId;
              if (!reqId || packet.type !== 'decision' || packet.requestId !== reqId || packet.peerId !== remotePeerId) { ws.close(1008, 'decision required'); return; }
            }
            if (!packet.accepted) { this.emit('rejected', { peerId: remotePeerId }); ws.close(); return; }
            const bound = this.store.peer(remotePeerId);
            if (bound && bound.fingerprint !== fingerprint) { ws.close(1008, 'identity changed'); return; }
            session = { ws, peerId: remotePeerId, fingerprint, name: packet.name, ip, incoming: false, approved: true, lastHeartbeat: Date.now() };
            this.sessions.set(remotePeerId, session);
            this.store.bindContact(ip, remotePeerId, fingerprint, packet.name);
            this.emit('connected', { peerId: remotePeerId, name: packet.name, ip });
            return;
          }
          await this.onPacket(session, packet);
        } catch (error) {
          this.emit('error-message', error instanceof Error ? error.message : String(error));
          ws.close(1011, 'protocol processing failed');
        } finally { buffered -= 1; }
      }).catch(error => {
        this.emit('error-message', error instanceof Error ? error.message : String(error));
        ws.close(1011, 'protocol processing failed');
      });
    });
    ws.on('close', () => {
      const active = session ?? (remotePeerId ? this.sessions.get(remotePeerId) : undefined);
      if (active && active.ws === ws && this.sessions.get(active.peerId) === active) {
        this.sessions.delete(active.peerId);
        this.store.failPendingMessages(active.peerId);
        this.failTransfers(active.peerId);
        this.emit('disconnected', { peerId: active.peerId });
      } else {
        for (const [id, item] of this.pending) if (item.ws === ws) {
          this.pending.delete(id);
          this.emit('request-expired', { requestId: id });
        }
      }
    });
    ws.on('error', error => this.emit('error-message', error.message));
    (ws as WebSocket & { requestId?: string }).requestId = uuid();
  }

  async probeFingerprint(ip: string, port: number): Promise<string> {
    const socket = tlsConnect({ host: ip, port, cert: this.identity.cert, key: this.identity.key, rejectUnauthorized: false });
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Peer did not respond')); }, 10_000);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        const peerCert = socket.getPeerCertificate();
        if (!peerCert.raw) { socket.destroy(); reject(new Error('Peer did not provide a TLS certificate')); return; }
        const fingerprint = fingerprintOf(peerCert.raw);
        socket.destroy();
        resolve(fingerprint);
      });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
  }

  async connect(ip: string, port: number, expected: { fingerprint: string; peerId?: string; reconfirm?: boolean }): Promise<{ peerId: string; name: string; fingerprint: string }> {
    if (expected.peerId && this.sessions.has(expected.peerId)) throw new ConnectionRejectedError('already-connected');
    const storedPeer = expected.peerId ? this.store.peer(expected.peerId) : undefined;
    if (storedPeer && storedPeer.fingerprint !== expected.fingerprint && !expected.reconfirm) {
      throw new Error('Peer identity changed; reconfirm the displayed fingerprint out of band before reconnecting');
    }
    const ws = new WebSocket(`wss://${ip}:${port}/peer`, { cert: this.identity.cert, key: this.identity.key, rejectUnauthorized: false, maxPayload: 512 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`Peer rejected connection (${res.statusCode})`)));
    });
    const tls = (ws as WebSocket & { _socket: TLSSocket })._socket;
    const cert = tls.getPeerCertificate();
    const fingerprint = cert.raw ? fingerprintOf(cert.raw) : '';
    if (expected.fingerprint !== fingerprint) {
      ws.close();
      throw new Error('Confirm the peer TLS fingerprint before connecting');
    }
    const requestId = uuid();
    let settled = false;
    let handshakeComplete = false;
    const handshake = new Promise<{ peerId: string; name: string; fingerprint: string }>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('Connection request timed out')); }, 90_000);
      ws.on('message', raw => {
        if (handshakeComplete) return;
        try {
          const result = decodePacket(raw.toString());
          if (!result || !result.success || result.data.type !== 'decision' || result.data.requestId !== requestId) { ws.close(1008, 'invalid handshake packet'); return; }
          if (!result.data.accepted) { handshakeComplete = true; clearTimeout(timer); reject(new ConnectionRejectedError(result.data.reason ?? 'unknown')); ws.close(); return; }
          if (expected.peerId && expected.peerId !== result.data.peerId) { handshakeComplete = true; clearTimeout(timer); reject(new Error('Peer identity changed')); ws.close(); return; }
          const existing = this.sessions.get(result.data.peerId);
          if (existing) {
            if (!existing.incoming || this.identity.peerId.localeCompare(result.data.peerId) > 0) {
              handshakeComplete = true; clearTimeout(timer); reject(new ConnectionRejectedError('already-connected')); ws.close(); return;
            }
            existing.ws.close();
          }
          const bound = this.store.peer(result.data.peerId);
          if (bound && bound.fingerprint !== fingerprint && !expected.reconfirm) { handshakeComplete = true; clearTimeout(timer); reject(new Error('Peer identity changed; reconfirm the displayed fingerprint out of band before reconnecting')); ws.close(); return; }
          const session: Session = { ws, peerId: result.data.peerId, fingerprint, name: result.data.name, ip, incoming: false, approved: true, lastHeartbeat: Date.now() };
          handshakeComplete = true;
          this.sessions.set(session.peerId, session);
          this.store.bindContact(ip, session.peerId, fingerprint, session.name);
          this.attachSessionMessages(session);
          clearTimeout(timer);
          resolve({ peerId: session.peerId, name: session.name, fingerprint });
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      ws.on('close', () => { if (!settled) { clearTimeout(timer); reject(new Error('Connection closed before acceptance')); } });
    });
    (ws as WebSocket & { requestId?: string }).requestId = requestId;
    ws.send(JSON.stringify({ type: 'request', version: 1, peerId: this.identity.peerId, name: this.identity.name, requestId }));
    try { return await handshake; }
    finally { settled = true; }
  }

  accept(requestId: string): void {
    const request = this.pending.get(requestId);
    if (!request) throw new Error('Connection request no longer exists');
    if (request.ws.readyState !== WebSocket.OPEN) throw new Error('Connection request has expired');
    if (this.sessions.has(request.peerId)) {
      this.pending.delete(requestId);
      request.ws.send(JSON.stringify({ type: 'decision', requestId, accepted: false, reason: 'already-connected', peerId: this.identity.peerId, name: this.identity.name }));
      request.ws.close();
      this.emit('request-expired', { requestId });
      throw new Error('已有与该设备的连接，请使用现有会话');
    }
    const session: Session = { ws: request.ws, peerId: request.peerId, fingerprint: request.fingerprint, name: request.name, ip: request.ip, incoming: true, approved: true, lastHeartbeat: Date.now() };
    this.sessions.set(session.peerId, session);
    this.pending.delete(requestId);
    this.store.bindContact(session.ip, session.peerId, session.fingerprint, session.name);
    request.ws.send(JSON.stringify({ type: 'decision', requestId, accepted: true, peerId: this.identity.peerId, name: this.identity.name }));
    this.emit('connected', { peerId: session.peerId, name: session.name, ip: session.ip });
  }

  getPendingRequest(requestId: string): Pending | undefined { return this.pending.get(requestId); }

  reject(requestId: string): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    request.ws.send(JSON.stringify({ type: 'decision', requestId, accepted: false, reason: 'declined', peerId: this.identity.peerId, name: this.identity.name }));
    request.ws.close();
  }

  private attachSessionMessages(session: Session): void {
    if ((session.ws as WebSocket & { attached?: boolean }).attached) return;
    (session.ws as WebSocket & { attached?: boolean }).attached = true;
    this.sessionChains.set(session.ws, Promise.resolve());
    session.ws.on('message', raw => {
      const current = this.sessionChains.get(session.ws) ?? Promise.resolve();
      this.sessionChains.set(session.ws, current.then(() => this.processSessionPacket(session, raw.toString())));
    });
    session.ws.on('close', () => {
      if (this.sessions.get(session.peerId) === session) {
        this.sessions.delete(session.peerId);
        this.store.failPendingMessages(session.peerId);
        this.failTransfers(session.peerId);
        this.emit('disconnected', { peerId: session.peerId });
      }
    });
  }

  private async processSessionPacket(session: Session, raw: string): Promise<void> {
    try {
      const result = decodePacket(raw);
      if (!result || !result.success) { session.ws.close(1008, 'invalid protocol packet'); return; }
      await this.onPacket(session, result.data);
    } catch (error) {
      this.emit('error-message', error instanceof Error ? error.message : String(error));
      session.ws.close(1011, 'file or protocol processing failed');
    }
  }

  private async onPacket(session: Session, packet: Packet): Promise<void> {
    if (session.ws.readyState !== WebSocket.OPEN || this.sessions.get(session.peerId) !== session) return;
    if (!session.approved) { session.ws.close(1008, 'session not approved'); return; }
    if (packet.type === 'message') {
      this.store.saveMessage({ id: packet.id, peerId: session.peerId, direction: 'incoming', text: packet.text, createdAt: packet.sentAt, status: 'received' });
      this.emit('message', { id: packet.id, peerId: session.peerId, direction: 'incoming', text: packet.text, createdAt: packet.sentAt, status: 'received' });
      session.ws.send(JSON.stringify({ type: 'ack', id: packet.id }));
    } else if (packet.type === 'ack') { this.store.updateMessage(packet.id, session.peerId, 'delivered'); this.emit('ack', packet.id); }
    else if (packet.type === 'heartbeat') session.lastHeartbeat = Date.now();
    else if (packet.type === 'file-offer') {
      if (this.incomingTransfers.has(packet.transferId) || this.incomingTransfers.size >= 4) {
        session.ws.send(JSON.stringify({ type: 'file-decision', transferId: packet.transferId, accepted: false }));
        this.emit('error-message', '同时最多处理 4 批文件，请稍后重试');
        return;
      }
      this.incomingTransfers.set(packet.transferId, { session, files: packet.files, completed: new Set(), cancelled: false, writes: new Map() });
      packet.files.forEach((file, index) => {
        this.store.startFile(`${packet.transferId}:${index}`, session.peerId, file.name, file.size, 'incoming');
        this.emitFile(`${packet.transferId}:${index}`);
      });
      this.emit('file-offer', { peerId: session.peerId, transferId: packet.transferId, files: packet.files });
    } else if (packet.type === 'file-decision') {
      const transfer = this.outgoingTransfers.get(packet.transferId);
      if (transfer && transfer.session === session && !transfer.accepted) {
        transfer.accepted = packet.accepted;
        const indices = packet.indices ?? transfer.files.map((_file, index) => index);
        if (indices.some(index => index >= transfer.files.length) || new Set(indices).size !== indices.length) {
          session.ws.close(1008, 'invalid file selection');
          return;
        }
        transfer.indices = indices;
        transfer.files.forEach((_file, index) => {
          if (!packet.accepted || !indices.includes(index)) {
            transfer.completed.add(index);
            this.store.updateFile(`${packet.transferId}:${index}`, 'cancelled');
            this.emitFile(`${packet.transferId}:${index}`);
          }
        });
        this.emit('file-decision', { transferId: packet.transferId, accepted: packet.accepted });
        if (packet.accepted) void this.streamFiles(packet.transferId);
        else this.outgoingTransfers.delete(packet.transferId);
      }
    } else if (packet.type === 'file-start') await this.startReceiveFile(session, packet);
    else if (packet.type === 'file-chunk') await this.writeFileChunk(session, packet);
    else if (packet.type === 'file-chunk-ack') {
      if (this.outgoingTransfers.get(packet.transferId)?.session === session) this.pendingChunkAcks.get(`${packet.transferId}:${packet.fileIndex}`)?.();
    }
    else if (packet.type === 'file-end') await this.finishReceiveFile(session, packet);
    else if (packet.type === 'file-result') {
      const transfer = this.outgoingTransfers.get(packet.transferId);
      if (!transfer || transfer.session !== session || transfer.completed.has(packet.fileIndex) || !transfer.indices?.includes(packet.fileIndex)) return;
      transfer.completed.add(packet.fileIndex);
      this.store.updateFile(`${packet.transferId}:${packet.fileIndex}`, packet.accepted ? 'sent' : 'failed');
      this.emitFile(`${packet.transferId}:${packet.fileIndex}`);
      this.emit('file-result', { transferId: packet.transferId, fileIndex: packet.fileIndex, accepted: packet.accepted, savedName: packet.savedName, error: packet.error });
      if (transfer.completed.size === transfer.files.length) this.outgoingTransfers.delete(packet.transferId);
    }
    else if (packet.type === 'cancel') {
      if (this.outgoingTransfers.get(packet.transferId)?.session === session || this.incomingTransfers.get(packet.transferId)?.session === session) await this.cancelTransfer(packet.transferId);
    }
    else if (packet.type === 'disconnect') session.ws.close();
    else if (packet.type === 'request' || packet.type === 'decision') session.ws.close(1008, 'unexpected handshake packet');
  }

  async sendMessage(peerId: string, text: string): Promise<string> {
    const session = this.requireSession(peerId);
    const message = { type: 'message' as const, id: uuid(), text, sentAt: Date.now() };
    this.store.saveMessage({ id: message.id, peerId, direction: 'outgoing', text, createdAt: message.sentAt, status: 'sending' });
    try { session.ws.send(JSON.stringify(message)); }
    catch (error) { this.store.updateMessage(message.id, peerId, 'failed'); throw error; }
    this.emit('message', { id: message.id, peerId, direction: 'outgoing', text, createdAt: message.sentAt, status: 'sending' });
    return message.id;
  }

  async offerFiles(peerId: string, paths: string[], names?: string[]): Promise<string> {
    if (!paths.length || paths.length > 100) throw new Error('Select between 1 and 100 files');
    const files: OutgoingFile[] = [];
    for (const [index, path] of paths.entries()) { const info = await stat(path); if (!info.isFile()) throw new Error('Only regular files can be sent'); files.push({ path, name: safeName(names?.[index] ?? basename(path)), size: info.size, modifiedAt: info.mtimeMs }); }
    const session = this.requireSession(peerId);
    if (this.outgoingTransfers.size >= 4) throw new Error('同时最多发送 4 批文件，请等待当前传输完成');
    const transferId = uuid();
    this.outgoingTransfers.set(transferId, { session, files, accepted: false, cancelled: false, completed: new Set() });
    files.forEach((file, index) => {
      this.store.startFile(`${transferId}:${index}`, peerId, file.name, file.size, 'outgoing', file.path);
      this.emitFile(`${transferId}:${index}`);
    });
    session.ws.send(JSON.stringify({ type: 'file-offer', transferId, files: files.map(({ name, size }) => ({ name, size })) }));
    return transferId;
  }

  async acceptFiles(transferId: string, directory: string): Promise<void> {
    const transfer = this.incomingTransfers.get(transferId);
    if (!transfer) throw new Error('File transfer is no longer available');
    await this.acceptFileDestinations(transferId, transfer.files.map(() => ({ directory })));
  }

  hasIncomingTransfer(transferId: string): boolean { return this.incomingTransfers.has(transferId); }

  async acceptFileDestinations(transferId: string, destinations: Array<FileDestination | null>): Promise<void> {
    const transfer = this.incomingTransfers.get(transferId);
    if (!transfer || transfer.cancelled || transfer.destinations) throw new Error('File transfer is no longer available');
    if (destinations.length !== transfer.files.length) throw new Error('Invalid file destinations');
    const resolved: Array<FileDestination | null> = [];
    for (const destination of destinations) {
      if (destination) {
        await mkdir(destination.directory, { recursive: true });
        resolved.push({ ...destination, directory: await realpath(destination.directory) });
      } else resolved.push(null);
    }
    if (transfer.cancelled || !this.incomingTransfers.has(transferId)) throw new Error('File transfer was disconnected or cancelled');
    transfer.destinations = resolved;
    const indices = resolved.flatMap((destination, index) => destination ? [index] : []);
    resolved.forEach((destination, index) => {
      if (!destination) {
        transfer.completed.add(index);
        this.store.updateFile(`${transferId}:${index}`, 'cancelled');
        this.emitFile(`${transferId}:${index}`);
      }
    });
    transfer.session.ws.send(JSON.stringify({ type: 'file-decision', transferId, accepted: indices.length > 0, indices }));
    if (!indices.length) this.incomingTransfers.delete(transferId);
  }

  rejectFiles(transferId: string): void {
    const transfer = this.incomingTransfers.get(transferId);
    if (!transfer) return;
    transfer.session.ws.send(JSON.stringify({ type: 'file-decision', transferId, accepted: false }));
    void this.cancelTransfer(transferId);
  }

  async cancel(transferId: string): Promise<void> {
    const outgoing = this.outgoingTransfers.get(transferId);
    if (outgoing) { outgoing.cancelled = true; outgoing.session.ws.send(JSON.stringify({ type: 'cancel', transferId })); }
    const incoming = this.incomingTransfers.get(transferId);
    if (incoming) incoming.session.ws.send(JSON.stringify({ type: 'cancel', transferId }));
    await this.cancelTransfer(transferId);
  }

  private async streamFiles(transferId: string): Promise<void> {
    const transfer = this.outgoingTransfers.get(transferId);
    if (!transfer) return;
    while (!transfer.accepted && !transfer.cancelled) await delay(25);
    if (!transfer.accepted || transfer.cancelled) return;
    try {
      for (let index = 0; index < transfer.files.length; index += 1) {
        if (transfer.cancelled || transfer.session.ws.readyState !== WebSocket.OPEN) break;
        if (!transfer.indices?.includes(index)) continue;
        const file = transfer.files[index]!;
        this.store.updateFile(`${transferId}:${index}`, 'transferring');
        this.emitFile(`${transferId}:${index}`);
        let chunkPermit = file.size > 0 ? this.waitForChunkAck(transferId, index) : undefined;
        transfer.session.ws.send(JSON.stringify({ type: 'file-start', transferId, fileIndex: index }));
        const hash = createHash('sha256'); let sent = 0;
        for await (const chunk of createReadStream(file.path, { highWaterMark: CHUNK })) {
          if (transfer.cancelled) break;
          if (!chunkPermit) throw new Error('Missing receiver transfer authorization');
          await chunkPermit;
          if (transfer.cancelled) break;
          const data = chunk as Buffer;
          sent += data.length;
          hash.update(data);
          while (transfer.session.ws.bufferedAmount > 2 * 1024 * 1024 && !transfer.cancelled) await delay(10);
          if (transfer.cancelled) break;
          transfer.session.ws.send(JSON.stringify({ type: 'file-chunk', transferId, fileIndex: index, data: data.toString('base64') }));
          chunkPermit = this.waitForChunkAck(transferId, index);
          this.emit('progress', { peerId: transfer.session.peerId, transferId, fileIndex: index, transferred: sent, total: file.size, direction: 'outgoing' });
        }
        if (chunkPermit) await chunkPermit;
        if (transfer.cancelled) break;
        const finalStat = await stat(file.path);
        if (sent !== file.size || finalStat.size !== file.size || finalStat.mtimeMs !== file.modifiedAt) throw new Error(`Source file changed while reading: ${file.name}`);
        transfer.session.ws.send(JSON.stringify({ type: 'file-end', transferId, fileIndex: index, size: sent, sha256: hash.digest('hex') }));
      }
    } catch (error) {
      this.emit('error-message', error instanceof Error ? error.message : String(error));
      if (transfer.session.ws.readyState === WebSocket.OPEN) transfer.session.ws.send(JSON.stringify({ type: 'cancel', transferId }));
      await this.cancelTransfer(transferId, 'failed');
    }
  }

  private async startReceiveFile(session: Session, packet: Extract<Packet, { type: 'file-start' }>): Promise<void> {
    const transfer = this.incomingTransfers.get(packet.transferId);
    const destination = transfer?.destinations?.[packet.fileIndex];
    if (!transfer || transfer.session !== session || !destination || transfer.cancelled || transfer.completed.has(packet.fileIndex) || transfer.writes.has(packet.fileIndex)) { session.ws.close(1008, 'unauthorized transfer'); return; }
    const temporary = join(destination.directory, `.lan-chat-${packet.transferId}-${packet.fileIndex}.part`);
    this.store.registerTemp(temporary);
    transfer.opening = (async () => {
      let handle: Awaited<ReturnType<typeof open>>;
      try { handle = await open(temporary, 'wx', 0o600); }
      catch (error) { this.store.forgetTemp(temporary); throw error; }
      transfer.writes.set(packet.fileIndex, { path: temporary, handle, size: 0, hash: createHash('sha256') });
    })();
    await transfer.opening;
    if (transfer.cancelled) return;
    this.store.updateFile(`${packet.transferId}:${packet.fileIndex}`, 'transferring');
    this.emitFile(`${packet.transferId}:${packet.fileIndex}`);
    session.ws.send(JSON.stringify({ type: 'file-chunk-ack', transferId: packet.transferId, fileIndex: packet.fileIndex }));
  }

  private async writeFileChunk(session: Session, packet: Extract<Packet, { type: 'file-chunk' }>): Promise<void> {
    const transfer = this.incomingTransfers.get(packet.transferId);
    const state = transfer?.writes.get(packet.fileIndex);
    if (!transfer || transfer.session !== session || transfer.cancelled || !state) { session.ws.close(1008, 'unauthorized transfer'); return; }
    const data = Buffer.from(packet.data, 'base64');
    state.size += data.length;
    if (state.size > transfer.files[packet.fileIndex]!.size) {
      session.ws.send(JSON.stringify({ type: 'cancel', transferId: packet.transferId }));
      await this.cancelTransfer(packet.transferId);
      return;
    }
    state.hash.update(data);
    await state.handle.writeFile(data);
    if (transfer.cancelled) return;
    session.ws.send(JSON.stringify({ type: 'file-chunk-ack', transferId: packet.transferId, fileIndex: packet.fileIndex }));
    this.emit('progress', { peerId: session.peerId, transferId: packet.transferId, fileIndex: packet.fileIndex, transferred: state.size, total: transfer.files[packet.fileIndex]!.size, direction: 'incoming' });
  }

  private async finishReceiveFile(session: Session, packet: Extract<Packet, { type: 'file-end' }>): Promise<void> {
    const transfer = this.incomingTransfers.get(packet.transferId);
    const state = transfer?.writes.get(packet.fileIndex);
    if (!transfer || transfer.session !== session || !state) { session.ws.close(1008, 'unauthorized transfer'); return; }
    await state.handle.sync();
    await state.handle.close();
    if (transfer.cancelled) return;
    const source = transfer.files[packet.fileIndex]!;
    const actualHash = state.hash.digest('hex');
    if (packet.size !== source.size || packet.size !== state.size || actualHash !== packet.sha256) {
      await rm(state.path, { force: true });
      this.store.forgetTemp(state.path);
      transfer.writes.delete(packet.fileIndex);
      session.ws.send(JSON.stringify({ type: 'file-result', transferId: packet.transferId, fileIndex: packet.fileIndex, accepted: false, error: 'File integrity check failed' }));
      session.ws.send(JSON.stringify({ type: 'cancel', transferId: packet.transferId }));
      await this.cancelTransfer(packet.transferId, 'failed');
      return;
    }
    const destination = transfer.destinations![packet.fileIndex]!;
    let media: { mediaType: string; thumbnailPath: string } | undefined;
    transfer.validating = Promise.resolve().then(() => destination.validate?.(state.path));
    try { media = await transfer.validating; }
    catch (error) {
      this.emit('error-message', `无法接收 ${source.name}：${error instanceof Error ? error.message : String(error)}`);
      session.ws.send(JSON.stringify({ type: 'file-result', transferId: packet.transferId, fileIndex: packet.fileIndex, accepted: false, error: '图片内容无效或超出资源限制' }));
      session.ws.send(JSON.stringify({ type: 'cancel', transferId: packet.transferId }));
      await this.cancelTransfer(packet.transferId, 'failed');
      return;
    }
    if (transfer.cancelled) return;
    transfer.finalizing = (async () => {
      const finalName = await this.uniqueDestination(destination.directory, safeName(destination.name ?? source.name), state.path);
      const finalPath = join(destination.directory, finalName);
      if (transfer.cancelled) { await rm(finalPath, { force: true }); return; }
      this.store.completeFile(`${packet.transferId}:${packet.fileIndex}`, session.peerId, media ? safeName(source.name) : finalName, packet.size, finalPath, state.path);
      transfer.writes.delete(packet.fileIndex);
      transfer.completed.add(packet.fileIndex);
      if (media) this.store.setFileImage(`${packet.transferId}:${packet.fileIndex}`, media.mediaType, media.thumbnailPath);
      this.emitFile(`${packet.transferId}:${packet.fileIndex}`);
      session.ws.send(JSON.stringify({ type: 'file-result', transferId: packet.transferId, fileIndex: packet.fileIndex, accepted: true, savedName: finalName }));
      this.emit('file-complete', { transferId: packet.transferId, fileIndex: packet.fileIndex, name: finalName, path: finalPath, size: packet.size });
      if (transfer.completed.size === transfer.files.length) this.incomingTransfers.delete(packet.transferId);
    })();
    await transfer.finalizing;
    transfer.validating = undefined;
    transfer.finalizing = undefined;
  }

  private async uniqueDestination(directory: string, name: string, temporary: string): Promise<string> {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; i < 10_000; i += 1) {
      const candidate = i === 0 ? name : `${stem} (${i})${ext}`;
      const destination = join(directory, candidate);
      try { await link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
      try { await rm(temporary); }
      catch (error) { await rm(destination, { force: true }); throw error; }
      return candidate;
    }
    throw new Error('Unable to choose a unique destination filename');
  }

  private async cancelTransfer(transferId: string, status: 'failed' | 'cancelled' = 'cancelled'): Promise<void> {
    const pending = this.cancellations.get(transferId);
    if (pending) return pending;
    const outgoing = this.outgoingTransfers.get(transferId);
    if (outgoing) outgoing.cancelled = true;
    const transfer = this.incomingTransfers.get(transferId);
    if (transfer) transfer.cancelled = true;
    const operation = this.cleanupTransfer(transferId, outgoing, transfer, status);
    this.cancellations.set(transferId, operation);
    try { await operation; }
    finally { this.cancellations.delete(transferId); }
  }

  private async cleanupTransfer(transferId: string, outgoing: OutgoingTransfer | undefined, transfer: IncomingTransfer | undefined, status: 'failed' | 'cancelled'): Promise<void> {
    if (transfer) {
      await transfer.opening?.catch(() => undefined);
      const media = await transfer.validating?.catch(() => undefined);
      await transfer.finalizing?.catch(() => undefined);
      if (media && transfer.writes.size) await rm(media.thumbnailPath, { force: true });
    }
    for (const item of [outgoing, transfer]) {
      if (!item) continue;
      item.files.forEach((_file, index) => {
        if (!item.completed.has(index)) {
          this.store.updateFile(`${transferId}:${index}`, status);
          this.emitFile(`${transferId}:${index}`);
        }
      });
    }
    if (transfer) {
      for (const state of transfer.writes.values()) {
        await state.handle.close();
        await rm(state.path, { force: true });
        this.store.forgetTemp(state.path);
      }
      transfer.writes.clear();
      this.incomingTransfers.delete(transferId);
    }
    this.outgoingTransfers.delete(transferId);
    for (const [key, resolve] of this.pendingChunkAcks) if (key.startsWith(`${transferId}:`)) { this.pendingChunkAcks.delete(key); resolve(); }
    this.emit('transfer-ended', { transferId, status });
  }

  private emitFile(id: string): void { this.emit('file-history', this.store.fileSummary(id)); }

  private waitForChunkAck(transferId: string, fileIndex: number): Promise<void> {
    const key = `${transferId}:${fileIndex}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingChunkAcks.delete(key); reject(new Error('File transfer stalled while waiting for receiver')); }, 30_000);
      this.pendingChunkAcks.set(key, () => { clearTimeout(timer); this.pendingChunkAcks.delete(key); resolve(); });
    });
  }

  private failTransfers(peerId: string): void {
    const ids = new Set([
      ...[...this.incomingTransfers].filter(([, transfer]) => transfer.session.peerId === peerId).map(([id]) => id),
      ...[...this.outgoingTransfers].filter(([, transfer]) => transfer.session.peerId === peerId).map(([id]) => id)
    ]);
    for (const id of ids) void this.cancelTransfer(id).catch(error => this.emit('error-message', `清理未完成文件失败：${error instanceof Error ? error.message : String(error)}`));
  }

  private requireSession(peerId: string): Session {
    const session = this.sessions.get(peerId);
    if (!session || !session.approved || session.ws.readyState !== WebSocket.OPEN) throw new Error('No accepted connection to this contact');
    return session;
  }

  disconnect(peerId: string): void {
    const session = this.sessions.get(peerId);
    if (session) {
      session.ws.send(JSON.stringify({ type: 'disconnect' }));
      session.ws.close();
      this.sessions.delete(peerId);
      this.store.failPendingMessages(peerId);
      this.failTransfers(peerId);
    }
  }
  async close(): Promise<void> {
    const transferIds = new Set([...this.incomingTransfers.keys(), ...this.outgoingTransfers.keys(), ...this.cancellations.keys()]);
    for (const id of transferIds) await this.cancelTransfer(id);
    for (const [peerId, session] of this.sessions) {
      this.sessions.delete(peerId);
      this.store.failPendingMessages(peerId);
      session.ws.close();
    }
    for (const request of this.pending.values()) request.ws.close();
    this.pending.clear();
    if (this.wss) await new Promise<void>(resolve => this.wss!.close(() => resolve()));
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
