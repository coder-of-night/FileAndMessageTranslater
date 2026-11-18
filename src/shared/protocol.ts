import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
const id = z.string().uuid();
export const packetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), version: z.literal(PROTOCOL_VERSION), peerId: id, name: z.string().max(80), requestId: id }),
  z.object({ type: z.literal('decision'), requestId: id, accepted: z.boolean(), peerId: id, name: z.string().max(80), reason: z.enum(['declined', 'already-connected', 'request-pending']).optional() }),
  z.object({ type: z.literal('message'), id, text: z.string().min(1).max(16_000), sentAt: z.number().int() }),
  z.object({ type: z.literal('ack'), id }),
  z.object({ type: z.literal('file-offer'), transferId: id, files: z.array(z.object({ name: z.string().min(1).max(240), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).min(1).max(100) }),
  z.object({ type: z.literal('file-decision'), transferId: id, accepted: z.boolean(), indices: z.array(z.number().int().nonnegative().max(99)).max(100).optional() }),
  z.object({ type: z.literal('file-start'), transferId: id, fileIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal('file-chunk'), transferId: id, fileIndex: z.number().int().nonnegative(), data: z.string().max(360_000) }),
  z.object({ type: z.literal('file-chunk-ack'), transferId: id, fileIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal('file-end'), transferId: id, fileIndex: z.number().int().nonnegative(), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ type: z.literal('file-result'), transferId: id, fileIndex: z.number().int().nonnegative(), accepted: z.boolean(), savedName: z.string().optional(), error: z.string().optional() }),
  z.object({ type: z.literal('cancel'), transferId: id }),
  z.object({ type: z.literal('heartbeat'), at: z.number().int() }),
  z.object({ type: z.literal('disconnect') })
]);

export type Packet = z.infer<typeof packetSchema>;
export type ChatMessage = { id: string; peerId: string; direction: 'incoming' | 'outgoing'; text: string; createdAt: number; status: 'sending' | 'delivered' | 'received' | 'failed' };
