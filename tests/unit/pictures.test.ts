import { expect, test } from 'bun:test';

import { normalizePicture } from '@/lib/storage/pictures';

const png = new Uint8Array(
  await Bun.file(new URL('../fixtures/profile.png', import.meta.url)).arrayBuffer(),
);
test('pictures are decoded, squared and re-encoded as WebP', async () => {
  const output = await normalizePicture(png);
  expect(output.toString('ascii', 0, 4)).toBe('RIFF');
  expect(output.toString('ascii', 8, 12)).toBe('WEBP');
  expect(await normalizePicture(output)).toBeInstanceOf(Buffer);
  expect(output.includes(Buffer.from('Exif'))).toBe(false);
});
test('rejects SVG, corrupt files and oversized uploads', async () => {
  await expect(
    normalizePicture(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
  ).rejects.toThrow('JPEG, PNG or WebP');
  await expect(normalizePicture(Buffer.from([0xff, 0xd8, 0xff, 0]))).rejects.toThrow(
    'could not be read',
  );
  await expect(normalizePicture(new Uint8Array(5 * 1024 * 1024 + 1))).rejects.toThrow('5 MB');
});
