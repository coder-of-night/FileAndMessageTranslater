import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PeerNode, FileDestination } from '../network/peer-node';
import type { Store } from '../storage/database';
import { IMAGE_CACHE_BYTES, MAX_IMAGE_BYTES, type ChatFile, type FileOffer } from '../../shared/history';
import { inspectRaster, isImageName, imageExtension } from './images';
import { safeName } from './filenames';

export type ReceiveDialogs = {
  savePath: (name: string, size: number) => Promise<string | null>;
  thumbnail: (path: string, destination: string) => Promise<void>;
  notify: (message: string) => void;
};

export class AutomaticReceiver {
  private queue = Promise.resolve();
  private sendQueue: Promise<void> = Promise.resolve();
  private reservationQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly reservations = new Map<string, number>();
  private readonly mediaDir: string;
  constructor(private readonly node: PeerNode, private readonly store: Store, dataDir: string, private readonly dialogs: ReceiveDialogs) {
    this.mediaDir = join(dataDir, 'images');
    node.on('file-offer', this.onOffer);
    node.on('file-history', this.onFile);
    node.on('transfer-ended', this.onEnded);
  }
  private onFile = (file: ChatFile) => {
    if (['received', 'failed', 'cancelled'].includes(file.status)) this.reservations.delete(file.id);
  };
  private onEnded = ({ transferId }: { transferId: string }) => {
    for (const id of this.reservations.keys()) if (id.startsWith(`${transferId}:`)) this.reservations.delete(id);
  };
  private onOffer = (offer: FileOffer) => {
    this.queue = this.queue.then(() => this.receive(offer)).catch(async error => {
      if (this.node.hasIncomingTransfer(offer.transferId)) await this.node.cancel(offer.transferId);
      this.dialogs.notify(`无法接收文件：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  private async cacheSize(): Promise<number> {
    await mkdir(this.mediaDir, { recursive: true });
    const files = await readdir(this.mediaDir);
    let size = 0;
    for (const name of files) size += (await stat(join(this.mediaDir, name))).size;
    return size + [...this.reservations.values()].reduce((sum, bytes) => sum + bytes, 0);
  }
  private reserve(id: string, bytes: number): Promise<boolean> {
    const operation = this.reservationQueue.then(async () => {
      const required = bytes + 12 * 1024 * 1024;
      if (await this.cacheSize() + required > IMAGE_CACHE_BYTES) return false;
      this.reservations.set(id, required);
      return true;
    });
    this.reservationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async receive(offer: FileOffer): Promise<void> {
    if (this.closed || !this.node.hasIncomingTransfer(offer.transferId)) return;
    const destinations: Array<FileDestination | null> = [];
    for (let index = 0; index < offer.files.length; index++) {
      if (this.closed || !this.node.hasIncomingTransfer(offer.transferId)) return;
      const file = offer.files[index]!;
      const id = `${offer.transferId}:${index}`;
      if (isImageName(file.name) && file.size <= MAX_IMAGE_BYTES && await this.reserve(id, file.size)) {
        const thumbnail = join(this.mediaDir, `${offer.transferId}-${index}.thumbnail.png`);
        destinations.push({
          directory: this.mediaDir,
          name: `${offer.transferId}-${index}-${safeName(file.name)}`,
          validate: async path => {
            const image = await inspectRaster(path);
            try { await this.dialogs.thumbnail(path, thumbnail); }
            catch (error) { await rm(thumbnail, { force: true }); throw error; }
            return { mediaType: image.mediaType, thumbnailPath: thumbnail };
          }
        });
      } else {
        if (isImageName(file.name)) this.dialogs.notify(`${file.name} 超过图片展示或缓存限制，将作为普通文件保存`);
        const path = await this.dialogs.savePath(safeName(file.name), file.size);
        destinations.push(path ? { directory: dirname(path), name: basename(path) } : null);
      }
    }
    if (!this.closed && this.node.hasIncomingTransfer(offer.transferId)) await this.node.acceptFileDestinations(offer.transferId, destinations);
  }
  send(peerId: string, paths: string[]): Promise<string> {
    const operation = this.sendQueue.then(() => this.prepareSend(peerId, paths));
    this.sendQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async prepareSend(peerId: string, paths: string[]): Promise<string> {
    if (this.closed) throw new Error('应用正在关闭');
    const prepared: Array<{ index: number; path: string; mediaType: string; thumbnail: string }> = [];
    try {
      for (let index = 0; index < paths.length; index++) {
        const path = paths[index]!;
        if (!isImageName(path)) continue;
        const info = await stat(path);
        if (info.size > MAX_IMAGE_BYTES) continue;
        const id = randomUUID();
        if (!await this.reserve(id, info.size)) { this.dialogs.notify('图片缓存已达 512 MiB，将作为普通文件发送'); continue; }
        try {
          const original = await inspectRaster(path);
          const snapshot = join(this.mediaDir, `${id}${imageExtension(original.mediaType)}`);
          const thumbnail = join(this.mediaDir, `${id}.thumbnail.png`);
          await copyFile(path, snapshot, constants.COPYFILE_EXCL);
          try {
            const image = await inspectRaster(snapshot);
            await this.dialogs.thumbnail(snapshot, thumbnail);
            prepared.push({ index, path: snapshot, mediaType: image.mediaType, thumbnail });
          } catch (error) { await rm(snapshot, { force: true }); await rm(thumbnail, { force: true }); throw error; }
        } finally { this.reservations.delete(id); }
      }
      const transferId = await this.node.offerFiles(peerId, paths.map((path, index) => prepared.find(item => item.index === index)?.path ?? path), paths.map(path => basename(path)));
      for (const image of prepared) {
        const id = `${transferId}:${image.index}`;
        this.store.setFileImage(id, image.mediaType, image.thumbnail);
        this.node.emit('file-history', this.store.fileSummary(id));
      }
      return transferId;
    } catch (error) {
      for (const file of prepared) { await rm(file.path, { force: true }); await rm(file.thumbnail, { force: true }); }
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.node.off('file-offer', this.onOffer);
    await Promise.all([this.queue, this.sendQueue]);
    this.node.off('file-history', this.onFile);
    this.node.off('transfer-ended', this.onEnded);
  }
}
