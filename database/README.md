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

The SQL's `IF NOT EXISTS` does not make non-empty installation supported.

## Full canonical catalog verification

Run `pnpm db:verify-schema` with `DATABASE_URL` (read-only target) and explicit `SCHEMA_ADMIN_URL` (management connection on the same
host/port/server). The admin role needs CREATEDB; the application role does not. Both URLs support only public schema. Do not put admin
credentials in application configuration. CI provides the management URL separately.

The verifier creates a random `billing_reference_<uuid>` database from template0, installs the canonical SQL, then compares a read-only
REPEATABLE READ target snapshot. It compares all 35 relations, 369 columns, 128 constraints (NOT NULL is a column property), 84 indexes,
plus database locale metadata and unexpected types/routines/triggers/rules/policies. Definitions retain precision, defaults, validation,
partial predicates, persistence and RLS flags. No data is copied and no target DDL/DML is executed. A differing locale from template0 is
reported as drift; this tool does not claim database data, owner/ACL, statistics, every extension feature or concurrent DDL equivalence.

Output includes canonical SHA256, server version, counts and missing/unexpected/changed objects. Drift exits 1. Configuration failures do
not print URLs or credentials. An unconfirmed CREATE or failed cleanup reports only the internally generated reference name and stage:
inspect ownership before manual cleanup; never bulk-drop by prefix. Confirmed own databases are closed and dropped in finally without FORCE.
The integration fixtures require broader privileges for their isolated negative cases; only their own random databases are mutated.
See `docs/IMPLEMENTATION_PLAN.md` for local PG18 evidence and the unexecuted PG16 CI boundary.

Billing facts remain in PostgreSQL. Redis is limited to coordination and short-lived hints. Settlement acceptance and credit-hold expiry use
PostgreSQL command receipts with a request digest, persisted result, idempotency key and explicit `command_identity`; partial unique indexes bind
each non-null identity to one tenant-scoped command. Redis never owns their replay or conflict decision. All database instants use
`TIMESTAMPTZ(3)` and all money/credit values use integer minor units.


## Generated Prisma artifacts (B6a)

`database/schema.sql` remains the only editable schema. Commit `database/generated/schema.prisma` and `provenance.json` only as outputs;
`src/generated/prisma/` is ignored and regenerated locally. Prisma/client/adapter-pg are pinned to 7.10.0.

- `SCHEMA_ADMIN_URL=<management URL> pnpm prisma:refresh`: create only an owned template0 reference, install canonical SQL, introspect from
  an empty bootstrap, validate, generate and publish the complete schema/provenance/Client set. No application DATABASE_URL, db push or migrations.
- `pnpm prisma:generate`: offline Client generation from the committed schema. Typecheck/build/test/integration scripts explicitly run it first.
- `SCHEMA_ADMIN_URL=<management URL> pnpm prisma:check`: independently rebuild in temporary directories and report missing/extra/changed
  bytes across the complete generated set. It does not overwrite current artifacts. Do not refresh before investigating drift.

Introspection emits the narrow `partialIndexes` Preview metadata exception documented in ADR-0003. CHECK and full SQL semantics remain
under the independent catalog gate. Source and compiled Client validation does not imply production writer migration.
Refresh publishers acquire `.billing-prisma-artifacts-publish.lock` atomically; a second publisher fails immediately. After a process crash,
inspect ownership and confirm no publisher is running before manually handling that lock or controlled `.backup-*`/`.next-*` directories.
Never run offline generate/build concurrently with refresh in the same checkout. No cross-directory crash-atomicity guarantee is claimed.
