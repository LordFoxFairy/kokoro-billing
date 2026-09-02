import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const migrationDirectory = join(process.cwd(), 'database', 'migrations');
const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
const errors: string[] = [];
const migrationFile = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/u;
const identifier = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const tablePattern = /\b(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+`?([a-zA-Z][a-zA-Z0-9_]*)`?/giu;
const namedObjectPattern = /\b(?:CONSTRAINT\s+(?!IF\b)|UNIQUE KEY|KEY)\s+`?([a-zA-Z][a-zA-Z0-9_]*)`?/giu;

for (const file of files) {
  if (!migrationFile.test(file)) errors.push(`${file}: migration filename must be NNNN-kebab-case.sql`);
  const sql = await readFile(join(migrationDirectory, file), 'utf8');
  for (const match of sql.matchAll(tablePattern)) {
    const table = match[1];
    if (table === undefined || !identifier.test(table) || !/^(entitlement|payment)_/u.test(table)) {
      errors.push(`${file}: invalid bounded-context table name: ${table ?? '<missing>'}`);
    }
    if (table?.startsWith('entitlement_entitlement_') || table?.startsWith('payment_payment_')) {
      errors.push(`${file}: duplicated bounded-context owner in table name: ${table}`);
    }
  }
  for (const match of sql.matchAll(namedObjectPattern)) {
    const name = match[1];
    if (name !== undefined && (!identifier.test(name) || /^(?:entitlement|payment)_(?:entitlement|payment)_/u.test(name))) {
      errors.push(`${file}: invalid constraint/index name: ${name ?? '<missing>'}`);
    }
  }
}

if (errors.length > 0) throw new Error(errors.join('\n'));
console.log(`SQL naming check passed: ${files.length} migrations`);
