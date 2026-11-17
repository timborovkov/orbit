import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const masterKeySchema = z.string().regex(/^[a-fA-F0-9]{64}$/);
function key() {
  const parsed = masterKeySchema.safeParse(process.env.ORBIT_ENCRYPTION_KEY);
  if (!parsed.success) throw new Error('Credential encryption is not configured.');
  return Buffer.from(parsed.data, 'hex');
}
export function encryptCredential(agentId: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(agentId));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}
export function decryptCredential(agentId: string, value: string) {
  const [version, iv, tag, data] = value.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Invalid credential');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'));
  decipher.setAAD(Buffer.from(agentId));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString(
    'utf8',
  );
}
