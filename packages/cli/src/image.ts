import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { ImagePart } from '@earshot/providers';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MEDIA_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export async function loadImage(input: string, cwd: string): Promise<ImagePart> {
  const remote = input.startsWith('https://');
  const pathname = remote ? new URL(input).pathname : input;
  const mediaType = MEDIA_TYPES[extname(pathname).toLowerCase()];
  if (!mediaType) {
    throw new Error('supported image formats are PNG, JPEG, GIF and WebP');
  }
  if (remote) return { type: 'image', data: input, mediaType };
  if (input.includes('://')) throw new Error('image URLs must use https');

  const path = resolve(cwd, input);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`${path} is larger than 20 MB`);
  return { type: 'image', data: (await readFile(path)).toString('base64'), mediaType };
}
