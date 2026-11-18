import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '../../shared/protocol';
import type { ChatFile, FileRecord, HistoryCursor, HistoryEntry } from '../../shared/history';

export type Contact = { id: number; ip: string; port: number; name: string; peerId: string | null; fingerprint: string | null };

export class Store {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'lan-chat.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (peer_id TEXT PRIMARY KEY, name TEXT NOT NULL, fingerprint TEXT NOT NULL, last_ip TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY, ip TEXT NOT NULL UNIQUE, port INTEGER NOT NULL, name TEXT NOT NULL, peer_id TEXT, fingerprint TEXT);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_peer_time ON messages(peer_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, result TEXT NOT NULL, saved_path TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transfer_temps (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    `);
    const columns = this.db.prepare('PRAGMA table_info(files)').all().map(row => row.name);
    this.transaction(() => {
      if (!columns.includes('direction')) this.db.exec("ALTER TABLE files ADD COLUMN direction TEXT NOT NULL DEFAULT 'incoming'");
      if (!columns.includes('media_type')) this.db.exec('ALTER TABLE files ADD COLUMN media_type TEXT');
      if (!columns.includes('thumbnail_path')) this.db.exec('ALTER TABLE files ADD COLUMN thumbnail_path TEXT');
      this.db.exec("UPDATE messages SET status='failed' WHERE status='sending'; UPDATE files SET result='failed' WHERE result IN ('waiting','transferring'); PRAGMA user_version = 2;");
    });
  }
  getMeta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  contacts(): Contact[] { return this.db.prepare('SELECT id,ip,port,name,peer_id AS peerId,fingerprint FROM contacts ORDER BY name COLLATE NOCASE').all() as unknown as Contact[]; }
  addContact(ip: string, port: number, name: string): Contact { const r = this.db.prepare('INSERT INTO contacts(ip,port,name) VALUES(?,?,?)').run(ip, port, name); return this.db.prepare('SELECT id,ip,port,name,peer_id AS peerId,fingerprint FROM contacts WHERE id=?').get(Number(r.lastInsertRowid)) as unknown as Contact; }
  editContact(id: number, ip: string, port: number, name: string): void { this.db.prepare('UPDATE contacts SET ip=?,port=?,name=? WHERE id=?').run(ip, port, name, id); }
  deleteContact(id: number): void { this.db.prepare('DELETE FROM contacts WHERE id=?').run(id); }
  bindContact(ip: string, peerId: string, fingerprint: string, name: string): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO peers(peer_id,name,fingerprint,last_ip,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(peer_id) DO UPDATE SET name=excluded.name,fingerprint=excluded.fingerprint,last_ip=excluded.last_ip,updated_at=excluded.updated_at').run(peerId, name, fingerprint, ip, Date.now());
      this.db.prepare('UPDATE contacts SET peer_id=?,fingerprint=? WHERE ip=?').run(peerId, fingerprint, ip);
    });
  }
  peer(peerId: string): { peerId: string; name: string; fingerprint: string; lastIp: string | null } | undefined {
    return this.db.prepare('SELECT peer_id AS peerId,name,fingerprint,last_ip AS lastIp FROM peers WHERE peer_id=?').get(peerId) as unknown as { peerId: string; name: string; fingerprint: string; lastIp: string | null } | undefined;
  }
  saveMessage(message: ChatMessage): void { this.db.prepare('INSERT OR IGNORE INTO messages(id,peer_id,direction,text,created_at,status) VALUES(?,?,?,?,?,?)').run(message.id,message.peerId,message.direction,message.text,message.createdAt,message.status); }
  updateMessage(id: string, peerId: string, status: ChatMessage['status']): void { this.db.prepare('UPDATE messages SET status=? WHERE id=? AND peer_id=?').run(status,id,peerId); }
  failPendingMessages(peerId: string): void { this.db.prepare("UPDATE messages SET status='failed' WHERE peer_id=? AND direction='outgoing' AND status='sending'").run(peerId); }
  messages(peerId: string, before: number | undefined, limit = 100): ChatMessage[] {
    const rows = before === undefined
      ? this.db.prepare('SELECT id,peer_id AS peerId,direction,text,created_at AS createdAt,status FROM messages WHERE peer_id=? ORDER BY created_at DESC LIMIT ?').all(peerId,limit)
      : this.db.prepare('SELECT id,peer_id AS peerId,direction,text,created_at AS createdAt,status FROM messages WHERE peer_id=? AND created_at<? ORDER BY created_at DESC LIMIT ?').all(peerId,before,limit);
    return (rows as unknown as ChatMessage[]).reverse();
  }
  saveFile(id: string, peerId: string, name: string, size: number, result: string, path: string | null): void {
    this.db.prepare('INSERT INTO files(id,peer_id,name,size,result,saved_path,created_at) VALUES(?,?,?,?,?,?,?)').run(id,peerId,name,size,result,path,Date.now());
  }
  registerTemp(path: string): void { this.db.prepare('INSERT OR REPLACE INTO transfer_temps(path,created_at) VALUES(?,?)').run(path,Date.now()); }
  forgetTemp(path: string): void { this.db.prepare('DELETE FROM transfer_temps WHERE path=?').run(path); }
  tempFiles(): string[] { return (this.db.prepare('SELECT path FROM transfer_temps').all() as unknown as Array<{ path: string }>).map(row => row.path); }
  completeFile(id: string, peerId: string, name: string, size: number, path: string, temporary: string): void {
    this.transaction(() => {
      this.db.prepare("INSERT INTO files(id,peer_id,name,size,result,saved_path,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,size=excluded.size,result='received',saved_path=excluded.saved_path").run(id,peerId,name,size,'received',path,Date.now());
      this.db.prepare('DELETE FROM transfer_temps WHERE path=?').run(temporary);
    });
  }
  startFile(id: string, peerId: string, name: string, size: number, direction: ChatFile['direction'], path: string | null = null): void {
    this.db.prepare('INSERT INTO files(id,peer_id,name,size,result,saved_path,created_at,direction) VALUES(?,?,?,?,?,?,?,?)').run(id,peerId,name,size,'waiting',path,Date.now(),direction);
  }
  updateFile(id: string, status: ChatFile['status']): void {
    this.db.prepare('UPDATE files SET result=? WHERE id=?').run(status,id);
  }
  setFileImage(id: string, mediaType: string, thumbnail: string): void {
    this.db.prepare('UPDATE files SET media_type=?,thumbnail_path=? WHERE id=?').run(mediaType,thumbnail,id);
  }
  file(id: string): FileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE id=?').get(id);
    if (!row) return undefined;
    return {
      kind: 'file', id: String(row.id), peerId: String(row.peer_id), name: String(row.name), size: Number(row.size),
      direction: row.direction === 'outgoing' ? 'outgoing' : 'incoming', createdAt: Number(row.created_at),
      status: row.result as ChatFile['status'], image: Boolean(row.media_type && row.thumbnail_path),
      savedPath: row.saved_path === null ? null : String(row.saved_path),
      thumbnailPath: row.thumbnail_path === null ? null : String(row.thumbnail_path),
      mediaType: row.media_type === null ? null : String(row.media_type)
    };
  }
  fileSummary(id: string): ChatFile | undefined {
    const file = this.file(id);
    if (!file) return undefined;
    const { savedPath: _path, thumbnailPath: _thumbnail, mediaType: _type, ...summary } = file;
    return summary;
  }
  history(peerId: string, before?: HistoryCursor): HistoryEntry[] {
    const ids = this.db.prepare(`SELECT id,kind FROM (
      SELECT id,'text' AS kind,created_at FROM messages WHERE peer_id=?
      UNION ALL SELECT id,'file' AS kind,created_at FROM files WHERE peer_id=?
    ) WHERE created_at<? OR (created_at=? AND id<?)
      ORDER BY created_at DESC,id DESC LIMIT 100`).all(peerId,peerId,before?.createdAt ?? Number.MAX_SAFE_INTEGER,before?.createdAt ?? Number.MAX_SAFE_INTEGER,before?.id ?? '');
    return ids.reverse().map(row => {
      if (row.kind === 'file') return this.fileSummary(String(row.id))!;
      const message = this.db.prepare('SELECT id,peer_id AS peerId,direction,text,created_at AS createdAt,status FROM messages WHERE id=?').get(String(row.id));
      return { ...(message as unknown as ChatMessage), kind: 'text' as const };
    });
  }
  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { action(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
