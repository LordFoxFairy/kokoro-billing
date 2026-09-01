import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDedicatedBillingConnection } from '../src/infrastructure/postgres/connection.js';
import type { RowDataPacket } from '../src/infrastructure/postgres/connection.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required and must be a PostgreSQL connection string');

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectories = [join(scriptDirectory, '..', 'database', 'migrations'), join(scriptDirectory, '..', '..', 'database', 'migrations')];
let migrationDirectory: string | undefined;
for (const candidate of migrationDirectories) {
  try { await access(candidate); migrationDirectory = candidate; break; }
  catch { /* try the next source/runtime layout */ }
}
if (!migrationDirectory) throw new Error('billing migration directory not found');

const connection = await createDedicatedBillingConnection(databaseUrl);
const migrationLock = 'kokoro-billing:migrations';
await connection.query('SELECT pg_advisory_lock(hashtext($1))', [migrationLock]);
try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS billing_schema_migrations (
      version VARCHAR(128) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    )
  `);
  const files = (await readdir(migrationDirectory)).filter((file) => /^\d+[-_].+\.sql$/u.test(file)).sort();
  for (const file of files) {
    const version = basename(file, '.sql');
    const sql = await readFile(join(migrationDirectory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const [rows] = await connection.query<RowDataPacket[]>('SELECT checksum FROM billing_schema_migrations WHERE version = $1', [version]);
    const applied = rows[0] as { checksum?: string } | undefined;
    if (applied) {
      if (applied.checksum !== checksum) throw new Error(`migration checksum mismatch: ${version}`);
      continue;
    }
    await connection.beginTransaction();
    try {
      await connection.query(sql);
      await connection.query('INSERT INTO billing_schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
      await connection.commit();
      console.log(`applied ${version}`);
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
} finally {
  await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [migrationLock]);
  await connection.end();
}
