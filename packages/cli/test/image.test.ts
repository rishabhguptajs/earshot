import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../../core/test/helpers.ts';
import { loadImage } from '../src/image.ts';

describe('image input', () => {
  test('reads a local image as base64 with its media type', () =>
    withTempDir(async (cwd) => {
      const path = join(cwd, 'pixel.png');
      await writeFile(path, 'hello');
      expect(await loadImage(path, cwd)).toEqual({
        type: 'image',
        data: 'aGVsbG8=',
        mediaType: 'image/png',
      });
    }));

  test('keeps an https image as a provider-side reference', async () => {
    expect(await loadImage('https://example.com/pixel.webp', '/workspace')).toEqual({
      type: 'image',
      data: 'https://example.com/pixel.webp',
      mediaType: 'image/webp',
    });
  });

  test('refuses unknown image formats instead of guessing', () =>
    expect(loadImage('picture.txt', '/workspace')).rejects.toThrow('supported image'));
});
