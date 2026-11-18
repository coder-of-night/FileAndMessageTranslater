import type { ChatMessage } from './protocol';
import type { Contact } from '../main/storage/database';
import type { HistoryCursor, HistoryEntry } from './history';

export type AppInfo = { name: string; peerId: string; fingerprint: string; addresses: string[]; port: number };
export type IncomingRequest = { requestId: string; peerId: string; fingerprint: string; ip: string; name: string };
export type FileOffer = { peerId: string; transferId: string; files: Array<{ name: string; size: number }> };
export type PeerEvent = { event: string; payload: unknown };
export type ConnectionRejection = 'declined' | 'already-connected' | 'request-pending' | 'unknown';
export type ConnectResult =
  | { ok: true; peerId: string; name: string; fingerprint: string }
  | { ok: false; reason: ConnectionRejection | 'cancelled' };

export interface DesktopApi {
  getInfo(): Promise<AppInfo>;
  listContacts(): Promise<Contact[]>;
  addContact(ip: string, port: number, name: string): Promise<Contact[]>;
  editContact(id: number, ip: string, port: number, name: string): Promise<Contact[]>;
  deleteContact(id: number): Promise<Contact[]>;
  connect(ip: string, port: number, name: string): Promise<ConnectResult>;
  acceptRequest(requestId: string): Promise<void>;
  rejectRequest(requestId: string): Promise<void>;
  sendMessage(peerId: string, text: string): Promise<string>;
  loadMessages(peerId: string, before?: number): Promise<ChatMessage[]>;
  loadHistory(peerId: string, before?: HistoryCursor): Promise<HistoryEntry[]>;
  sendDroppedFiles(peerId: string, files: File[]): Promise<string>;
  imageContextMenu(id: string): Promise<void>;
  cancelTransfer(transferId: string): Promise<void>;
  disconnect(peerId: string): Promise<void>;
  onEvent(callback: (event: PeerEvent) => void): () => void;
}

declare global {
  interface Window { desktop: DesktopApi; }
}
