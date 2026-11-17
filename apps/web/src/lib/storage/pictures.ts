import sharp from 'sharp';

export const maxPictureBytes = 5 * 1024 * 1024;
export async function normalizePicture(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > maxPictureBytes)
    throw new Error('Choose a picture smaller than 5 MB.');
  const data = Buffer.from(bytes);
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) throw new Error('Choose a JPEG, PNG or WebP picture.');
  try {
    const image = sharp(data, { limitInputPixels: 32_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1) throw new Error('Animated image');
    return await image.rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
  } catch {
    throw new Error('This picture could not be read. Choose a still image under 32 megapixels.');
  }
}
