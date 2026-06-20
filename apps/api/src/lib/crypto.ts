import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env.js';

// AES-256-GCM encryption for credentials stored in ingestion_sources.config.
// Format (base64): [12-byte IV][16-byte auth tag][ciphertext].
// In production CONFIG_ENCRYPTION_KEY should come from a KMS (AWS KMS / Supabase
// Vault), not a plain env var — but the interface here stays the same.

const ALGO = 'aes-256-gcm';

function key(): Buffer {
  const raw = env.configEncryptionKey();
  if (!raw) throw new Error('CONFIG_ENCRYPTION_KEY is not set — cannot encrypt/decrypt source config');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('CONFIG_ENCRYPTION_KEY must be 32 bytes (base64-encoded)');
  return buf;
}

export function encryptConfig(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptConfig(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
