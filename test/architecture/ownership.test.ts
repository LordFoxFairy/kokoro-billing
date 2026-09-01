import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const text = async (path: string) => readFile(join(process.cwd(), path), 'utf8');

describe('billing ownership architecture', () => {
  it('keeps card redemption inside Billing and excludes timer/legacy payment writers', async () => {
    const server = await text('src/interfaces/http/server.ts');
    const main = await text('src/main.ts');
    expect(server).toContain("'/billing/redeem'");
    expect(server).toContain("'/admin/billing/redeem-campaigns'");
    expect(main).toContain('new RedeemService');
    expect(main).not.toContain('kokoro-payment');
    expect(main).not.toContain('sweeper');
  });
});
