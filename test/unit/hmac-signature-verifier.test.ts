import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HmacProviderSignatureVerifier } from '../../src/infrastructure/providers/hmac-signature-verifier.js';

const sign = (secret: string, rawBody: string, timestamp: number): string => `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

describe('HmacProviderSignatureVerifier', () => {
  it('verifies timestamped provider signatures and rejects stale or tampered payloads', () => {
    const verifier = new HmacProviderSignatureVerifier({ mock: 'secret' }, 300);
    const timestamp = 1_700_000_000;
    const rawBody = '{"id":"evt-1"}';
    expect(verifier.verify('mock', rawBody, sign('secret', rawBody, timestamp), timestamp)).toBe(true);
    expect(verifier.verify('mock', '{"id":"evt-2"}', sign('secret', rawBody, timestamp), timestamp)).toBe(false);
    expect(verifier.verify('mock', rawBody, sign('secret', rawBody, timestamp), timestamp + 301)).toBe(false);
  });
});
