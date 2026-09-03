import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDedicatedBillingConnection, runWithBillingContext, type RowDataPacket } from '../src/infrastructure/postgres/connection.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required and must be a PostgreSQL connection string');

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const schemaPath = resolve(scriptDirectory, '..', 'database', 'schema.sql');
const schema = await readFile(schemaPath, 'utf8');
if (schema.trim() === '') throw new Error('database/schema.sql must not be empty');

const connection = await createDedicatedBillingConnection(databaseUrl);
try {
  await runWithBillingContext(async () => {
    await connection.beginTransaction();
    try {
      await connection.execute('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['kokoro-billing:canonical-schema']);
      const [tables] = await connection.execute<(RowDataPacket & { table_name: string })[]>(`
        SELECT tablename AS table_name
        FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);
      if (tables.length > 0) {
        throw new Error(`db:apply-schema requires a blank database; found tables: ${tables.map((table) => table.table_name).join(', ')}`);
      }
      await connection.execute(schema);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  });
  console.log(`installed canonical schema: ${schemaPath}`);
} finally {
  await connection.end();
}
