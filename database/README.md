# Database

PostgreSQL 16 is the CI baseline. The 2026-09-08 local verification used PostgreSQL 18.4; this does not replace a CI 16 run.
`database/schema.sql` is the sole V1 canonical schema.

`pnpm db:apply-schema` installs into an exclusive, empty Billing database, in an existing `public` schema. The URL may omit `schema`
or contain only `schema=public`; all non-public values, including repeated query parameters, are rejected before connecting.
Connection URI `options` cannot redirect installation: the installer fixes the transaction search path and UTC explicitly.

`scripts/canonical-schema.ts` owns installation. It checks CREATE privilege and user relations, independent types and functions/procedures
across all non-system schemas after acquiring a transaction-scoped advisory lock. Existing views, sequences and types also make a database
non-empty. It does not create/drop schemas, reset databases or upgrade existing tables. Installation uses one client, READ COMMITTED and
bounded connection/query/lock/close waits; failed DDL rolls back. The advisory lock coordinates compliant installers, not arbitrary concurrent DDL.

Run installation only against a database created for this task. Tests in `test/integration/schema-installation.test.ts` need a PostgreSQL
management role with CREATEDB and the fixture capabilities (the CI PostgreSQL service role is a superuser). They create/drop only their own
random databases, and backend-termination tests target only the matching fixture database and query marker. They never install into or reset
the management database itself.

The SQL's `IF NOT EXISTS` does not make non-empty installation supported. Complete catalog drift validation is still pending B5 in
`docs/IMPLEMENTATION_PLAN.md`; existing partial schema assertions must not be described as complete drift coverage.

Billing facts remain in PostgreSQL. Redis is limited to coordination and short-lived hints. Settlement acceptance and credit-hold expiry use
PostgreSQL command receipts with a request digest, persisted result, idempotency key and explicit `command_identity`; partial unique indexes bind
each non-null identity to one tenant-scoped command. Redis never owns their replay or conflict decision. All database instants use
`TIMESTAMPTZ(3)` and all money/credit values use integer minor units.
