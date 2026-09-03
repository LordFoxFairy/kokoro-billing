# Database

PostgreSQL 16 only. `database/schema.sql` is the sole V1 canonical schema.

`pnpm db:apply-schema` installs the current schema into a clean database. `CREATE TABLE IF NOT EXISTS` remains available for convenient direct/local SQL execution; the runner rejects a non-empty database, and schema drift is detected separately rather than silently upgraded.

Billing facts remain in PostgreSQL. Redis is limited to coordination and short-lived idempotency hints. All database instants use `TIMESTAMPTZ(3)` and all money/credit values use integer minor units.
