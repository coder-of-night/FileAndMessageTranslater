import { readFile, stat } from 'node:fs/promises';
import { imageSize } from 'image-size';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../../shared/history';

const formats: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const isImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(name);

export async function inspectRaster(path: string): Promise<{ mediaType: string; width: number; height: number }> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) throw new Error('图片必须为 20 MiB 以内的普通文件');
  const data = await readFile(path);
  const dimensions = imageSize(data);
  const mediaType = dimensions.type ? formats[dimensions.type] : undefined;
  if (!mediaType || !dimensions.width || !dimensions.height) throw new Error('仅支持有效的 PNG、JPEG、GIF 或 WebP 图片');
  if (dimensions.width > 12_000 || dimensions.height > 12_000 || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw new Error('图片尺寸过大（最多 2400 万像素，单边不超过 12000）');
  return { mediaType, width: dimensions.width, height: dimensions.height };
}

export function imageExtension(type: string): string {
  return type === 'image/jpeg' ? '.jpg' : type === 'image/gif' ? '.gif' : type === 'image/webp' ? '.webp' : '.png';
}
