import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const schemaPath = join(process.cwd(), 'database', 'schema.sql');
const sql = await readFile(schemaPath, 'utf8');
const errors: string[] = [];
const identifier = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const tablePattern = /\bCREATE TABLE(?: IF NOT EXISTS)?\s+`?([a-zA-Z][a-zA-Z0-9_]*)`?/giu;
const namedObjectPattern = /\bCONSTRAINT\s+`?([a-zA-Z][a-zA-Z0-9_]*)`?/giu;

if (!/^CREATE TABLE/imu.test(sql)) errors.push('database/schema.sql: canonical schema must contain CREATE TABLE statements');
const crossTableConstraintPattern = new RegExp([['FOR', 'EIGN'].join(''), '\\s+', 'KEY'].join(''), 'iu');
const referencePattern = new RegExp(['REF', 'ERENCES'].join(''), 'iu');
if (crossTableConstraintPattern.test(sql) || referencePattern.test(sql)) errors.push('database/schema.sql: cross-table database constraints are not allowed in Billing V1');
if (/\bTIMESTAMP(?:\s*\(|\s+WITH|\s+WITHOUT)?\b/iu.test(sql.replace(/\bTIMESTAMPTZ\b/giu, ''))) errors.push('database/schema.sql: use TIMESTAMPTZ(3) for database instants');
if (/TIMESTAMPTZ(?!\(3\))/iu.test(sql)) errors.push('database/schema.sql: all timestamptz columns must use precision 3');

for (const match of sql.matchAll(tablePattern)) {
  const table = match[1];
  if (table === undefined || !identifier.test(table) || !/^(entitlement|payment)_/u.test(table)) {
    errors.push(`database/schema.sql: invalid bounded-context table name: ${table ?? '<missing>'}`);
  }
  if (table?.startsWith('entitlement_entitlement_') || table?.startsWith('payment_payment_')) {
    errors.push(`database/schema.sql: duplicated bounded-context owner in table name: ${table}`);
  }
}
for (const match of sql.matchAll(namedObjectPattern)) {
  const name = match[1];
  if (name !== undefined && !identifier.test(name)) errors.push(`database/schema.sql: invalid constraint name: ${name}`);
}

if (errors.length > 0) throw new Error(errors.join('\n'));
console.log('SQL schema check passed: database/schema.sql');
