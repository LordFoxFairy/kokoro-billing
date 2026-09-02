import type { Connection, RowDataPacket } from '../../application/ports.js';

export class ProviderAccountService {
  public constructor(private readonly connection: Connection) {}

  public async resolveTenantId(provider: string, externalAccountRef: string): Promise<string | null> {
    const [rows] = await this.connection.execute<(RowDataPacket & { tenant_id: string })[]>(
      `SELECT tenant_id FROM payment_provider_account
        WHERE provider = $1 AND external_account_ref = $2 AND status = 'active'`,
      [provider, externalAccountRef],
    );
    return rows[0]?.tenant_id ?? null;
  }
}
