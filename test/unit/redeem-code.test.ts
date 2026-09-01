import { describe, expect, it } from 'vitest';
import { formatRedeemCode, generateRedeemCode, hashRedeemCode, normalizeRedeemCode } from '../../src/modules/redeem/redeem-code.js';

describe('redeem code crypto', () => {
  it('normalizes human-entered separators and case', () => expect(normalizeRedeemCode(' koko-abcd-2345-efgh-jkmn ')).toBe('KOKOABCD2345EFGHJKMN'));
  it('generates a formatted code without ambiguous characters', () => {
    const code = generateRedeemCode(() => 1);
    expect(code).toMatch(/^KOKO-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
    expect(code.slice(5)).not.toMatch(/[ILO01]/u);
  });
  it('hashes normalized code and never requires plaintext persistence', () => {
    const secret = 'x'.repeat(32);
    expect(hashRedeemCode('KOKO-ABCD-2345-EFGH-JKMN', secret)).toBe(hashRedeemCode('koko abcd 2345 efgh jkmn', secret));
    expect(hashRedeemCode('KOKO-ABCD-2345-EFGH-JKMN', secret)).toHaveLength(64);
  });
  it('rejects malformed code and weak secret', () => {
    expect(() => formatRedeemCode('A'.repeat(15))).toThrow('billing.redeem_code_invalid');
    expect(() => hashRedeemCode('KOKO-ABCD-2345-EFGH-JKMN', 'short')).toThrow('billing.redeem_secret_too_short');
  });
});
