// API token helpers. We store only the SHA-256 hash; the plaintext is shown once at creation.
import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'slk_'; // SellerFolio Live Key

export function generateToken(): string {
  return PREFIX + randomBytes(32).toString('base64url');
}

export function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function lastFour(plain: string): string {
  return plain.slice(-4);
}
