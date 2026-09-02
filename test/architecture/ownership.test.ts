import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const text = async (path: string) => readFile(join(process.cwd(), path), 'utf8');

describe('billing ownership architecture', () => {
  it('keeps credit redemption inside Billing without exposing retired HTTP aliases', async () => {
    const server = await text('src/interfaces/http/server.ts');
    const main = await text('src/main.ts');
    expect(server).not.toContain("'/billing/redeem'");
    expect(server).not.toContain("'/admin/billing/redeem-campaigns'");
    expect(main).not.toContain('new RedeemService');
    expect(main).not.toContain('new RedeemAdminService');
    expect(main).not.toContain('kokoro-payment');
    expect(main).not.toContain('sweeper');
  });
});
