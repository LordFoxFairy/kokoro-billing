import { createHmac, randomBytes } from 'node:crypto';

// Ambiguous characters are excluded so an operator can read a generated code aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^KOKO-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/u;

export function normalizeRedeemCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/gu, '');
}

export function formatRedeemCode(compact: string): string {
  if (!/^[A-HJ-NP-Z2-9]{16}$/u.test(compact)) throw new Error('billing.redeem_code_invalid');
  return `KOKO-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12)}`;
}

function randomByte(): number {
  const byte = randomBytes(1).at(0);
  if (byte === undefined) throw new Error('billing.random_byte_unavailable');
  return byte;
}

export function generateRedeemCode(random: () => number = randomByte): string {
  let compact = '';
  while (compact.length < 16) {
    const byte = random();
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new RangeError('random byte must be 0-255');
    const limit = 256 - (256 % ALPHABET.length);
    if (byte >= limit) continue;
    compact += ALPHABET[byte % ALPHABET.length];
  }
  return formatRedeemCode(compact);
}

export function hashRedeemCode(code: string, secret: string): string {
  if (secret.trim().length < 32) throw new Error('billing.redeem_secret_too_short');
  const normalized = normalizeRedeemCode(code);
  if (!normalized.startsWith('KOKO') || normalized.length !== 20 || !CODE_PATTERN.test(formatRedeemCode(normalized.slice(4)))) {
    throw new Error('billing.redeem_code_invalid');
  }
  return createHmac('sha256', secret).update(normalized, 'utf8').digest('hex');
}
