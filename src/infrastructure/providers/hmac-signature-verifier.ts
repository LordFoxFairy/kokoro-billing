import { createHmac, timingSafeEqual } from 'node:crypto';

export class HmacProviderSignatureVerifier {
  public constructor(private readonly secrets: Readonly<Record<string, string>>, private readonly toleranceSeconds = 300) {}

  public verify(provider: string, rawBody: string, signatureHeader: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    const secret = this.secrets[provider];
    if (!secret) return false;
    const parts = new Map(signatureHeader.split(',').map((part) => part.split('=', 2) as [string, string]));
    const timestamp = Number(parts.get('t'));
    const signature = parts.get('v1');
    if (!Number.isSafeInteger(timestamp) || !signature || Math.abs(nowSeconds - timestamp) > this.toleranceSeconds || !/^[0-9a-f]{64}$/u.test(signature)) return false;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  }
}
