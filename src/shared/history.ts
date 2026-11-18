import type { ChatMessage } from './protocol';

export type ChatFile = {
  kind: 'file';
  id: string;
  peerId: string;
  direction: 'incoming' | 'outgoing';
  name: string;
  size: number;
  createdAt: number;
  status: 'waiting' | 'transferring' | 'sent' | 'received' | 'cancelled' | 'failed';
  image: boolean;
};
export type HistoryEntry = (ChatMessage & { kind: 'text' }) | ChatFile;
export type HistoryCursor = { createdAt: number; id: string };
export type FileRecord = ChatFile & { savedPath: string | null; thumbnailPath: string | null; mediaType: string | null };
export type FileOffer = { peerId: string; transferId: string; files: Array<{ name: string; size: number }> };
export type TransferProgress = { peerId: string; transferId: string; fileIndex: number; transferred: number; total: number; direction: 'incoming' | 'outgoing' };

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 24_000_000;
export const IMAGE_CACHE_BYTES = 512 * 1024 * 1024;
export const imageUrl = (id: string, thumbnail = true) => `lan-image://image/${encodeURIComponent(id)}${thumbnail ? '?thumbnail=1' : ''}`;
