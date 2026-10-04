# kokoro-billing contract governance

## Current and target artifacts

Billing owns both machine sources in this directory. They describe two distinct
states; they are not interchangeable versions of one deployed surface.

| State           | Machine source                                       | Operations | Transport                                 | Artifact status                                              |
| --------------- | ---------------------------------------------------- | ---------: | ----------------------------------------- | ------------------------------------------------------------ |
| Current runtime | [`openapi/v1/openapi.yaml`](openapi/v1/openapi.yaml) |         17 | existing `/v1/**` plus unversioned probes | `stable`, used for current Fastify route parity              |
| Target          | [`openapi/v2/openapi.yaml`](openapi/v2/openapi.yaml) |         24 | `/v2/**` plus unversioned probes          | `3.0.0-experimental.2`, not published, deployed, or consumed |

The target artifact SemVer and the HTTP transport prefix are independent. The
breaking clean-slate artifact is `3.0.0-experimental.2`; its routes intentionally
remain under `/v2`. The private package version is not a wire version. Human
semantics live in [`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md), which is
not a second editable field-level contract.

Current source digests:

```text
openapi/v1/openapi.yaml  58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63
openapi/v2/openapi.yaml  7d63133656a99a536bdae22c02b3a6796f80f12f42e44bdcdbdd338024010494
```

Historical candidate narratives and old validation counts are available in Git
history and the owner [`../docs/CURRENT.md`](../docs/CURRENT.md). They are not
current generation or runtime evidence.

## Owner, visibility, and authority

**Owner:** `kokoro-billing`. **Visibility:** `internal-owner`.

The contract covers Billing health/readiness/metrics, storefront reads,
Credit/subscription reads, checkout, per-attempt admission and execution
evidence ingress, settlement/refund, hold expiry, admin refund, and payment
provider webhooks. It does not define the BFF public Product API, IAM identity,
Agent Run, Scheduler schedules, another owner's database model, or browser
authority.

Every operation declares exact owner, visibility, stability, idempotency, and
permission extensions. Tenant, actor, service identity, and payment authority
come from authenticated transport context. Request bodies do not self-report a
payer, trusted subject, final charge, price, rate, multiplier, or settlement
amount for model usage. Browser traffic continues through Web and BFF; an IAM
user/BFF authentication alternative does not make this an externally public
contract.

## Target per-attempt usage contract

The target Admission and Execution shapes bind one physical model attempt. The
identity includes the run/call/attempt lineage, immutable planned binding and
execution bound, and a reference to the Agent-owned strict usage artifact.
Billing pins that artifact rather than copying its schema:

```text
Agent artifact version: 1.0.0
Agent usage schema SHA-256: eb3e226f2c5ede407b61558c0375a373a8a7985f333b3d62a6c2b148469043d0
```

Durable Admission representations echo the usage artifact identity and
execution-bound reference/digest so an original-key replay or GET can verify
the same immutable admission. Capture, release, and execution-event commands
carry a closed evidence identity; they do not embed arbitrary usage bytes or a
generic service receipt. A `202` execution-event response acknowledges only a
durable inbox representation, never provider success or settlement.

Authorization knowledge and dispatch knowledge are separate:

- `authorization_status`: `authorized | denied | expired | unknown`;
- `dispatch_status`: `awaiting | not_dispatched | started | unknown`.

`authorization_status` records the owner decision at the attempt's first
dispatch admission; it is not recalculated from wall-clock time. A durable
`started` dispatch requires `authorized`. Once dispatch legally starts, passing
`valid_until` does not rewrite that decision to `expired`, prove that the
provider stopped, or authorize release. Unknown dispatch remains unknown; it is
not inferred as `not_dispatched`.

Missing, incomplete, unsupported, or binding-mismatched evidence remains
pending or under review. It is never guessed as zero. Release is restricted to
final proof of `not_dispatched` or a verified settled remainder; timeout,
cancellation, lease expiry, request failure, and wall-clock expiry alone are
not release authority. Billing remains the sole owner of rate revisions,
pricing snapshots, normalization/rounding, Credit holds, charges, releases,
ledger effects, and reconciliation.

## Credit and amount rules

The target machine definition for Credit is
`components.schemas.CreditMicros.x-kokoro-credit-unit`:

```text
definition_version = 1
display_unit = credit
micros_per_credit = "1000000"
```

`CreditMicros` is a decimal integer string and `NonNegativeCreditMicros`
combines that unit with the nonnegative constraint. Cash `amount_minor`, ledger
sequence values, and provider currency remain separate facts. This metadata is
not a cash exchange rate, a grant amount, or permission for callers to compute
charges. Billing computes monetary and Credit effects from immutable owner
revisions with integer/exact arithmetic; consumers display owner results.

## Generation and read-only outputs

`contract/openapi/v2/openapi.yaml` is the only editable target machine source.
The pinned local toolchain is:

```text
@hey-api/openapi-ts 0.99.0
Prettier 3.9.6
TypeScript 6.0.3
```

Generate and verify with:

```bash
pnpm contract:generate
pnpm contract:generated:check
```

The generator writes exactly four read-only files under
`src/generated/billing-api/`:

```text
index.ts
types.gen.ts
schemas.gen.ts
provenance.json
```

`provenance.json` records the source path, artifact version, source bytes and
SHA-256, pinned generator/formatter/TypeScript versions, the complete schema
binding map, and output hashes. Generation occurs in a temporary directory;
check mode regenerates there and requires byte equality. The artifact verifier
parses generated schema literals without executing generated code, rejects
unknown/duplicate/nonliteral exports, rejects foreign destination files, and
requires the source component set and local `$ref` graph to be closed.

The target currently contains 42 schema components. The present personal HTTP
bootstrap uses Ajv 8.20.0 with ajv-formats 3.0.1 and compiles the exact
42-component generated registry. It rejects missing, extra, duplicate-target,
or uncompiled bindings and keeps coercion, defaults, and removal of additional
properties disabled. This bootstrap evidence does not mean the 24 target v2
operations are implemented.

Generated files are never edited by hand. A source change must regenerate all
affected outputs and update this README's target digest in the same reviewed
slice. `pnpm contract:generated:check` is the drift gate; a TypeScript compile
or schema-count assertion alone is not generation proof.

## Validation

Run:

```bash
pnpm contract:check
pnpm contract:generated:check
```

`contract:check` preserves exact parity for the current 17-operation v1
runtime and independently verifies the target 24-operation v2 source. Target
checks cover OpenAPI syntax, local references, operation IDs and governance,
tenant/request identity, permission and idempotency metadata, closed command
and response shapes, explicit errors, webhook signature/ACK differences,
strict Agent artifact identity, immutable Admission/evidence references,
unknown-state preservation, and the `started => authorized` rule.

These checks do not prove target controller/service/repository behavior,
PostgreSQL transactions, provider behavior, or a consumer rollout. Full owner
verification also runs formatting, lint, type checking, build, SQL checks, and
tests; skipped resource tests remain skipped evidence rather than integration
success.

## Idempotency, errors, and breaking changes

Commands use their declared stable business identity and required
`Idempotency-Key` or provider event identity. Same-key/same-body replay must
return the original durable representation; identity, binding, or digest drift
is a conflict. Lost acknowledgements recover through the original key or the
declared GET resource, not a new command identity. Tenant-invisible resources
remain nondisclosing, and stable error codes—not exception text—form the error
contract.

Breaking changes include removing or renaming routes, methods, headers,
request/response/error fields; tightening accepted values; changing authority,
tenant, idempotency, cursor, state, or unit semantics; and changing governance
extensions. They require a new owner artifact version and a coordinated
consumer cutover. This clean-slate target does not add compatibility aliases,
fallback DTOs, or a second editable schema. Git preserves history.

## Publication and consumer workflow

A consumer pins this tuple:

```text
repository
immutable commit or tag
source path
OpenAPI info.version
SHA-256
```

The consumer verifies the digest, generates or updates its own read-only
artifact, reviews permissions/tenant/idempotency/errors/timeouts, and runs
contract plus integration/smoke tests. It must not import Billing ORM/SQL types
or copy an editable Billing schema. BFF publishes only its own public
projection; it does not republish this internal contract unchanged.

The current target has not been published or pinned by Agent. Still open are:

- Billing Admission/Execution controllers, services, repositories, schema,
  workers, bounded recovery, and amount transactions;
- real PostgreSQL concurrency/rollback/idempotency and lost-ACK recovery;
- an Agent-owned authenticated evidence read/delivery seam and Billing pin;
- Agent authorize → dispatch → evidence ACK wiring;
- actual-only capture/release, unknown recovery, ledger/reconciliation, real
  provider evidence, and browser/user journeys;
- immutable contract publication and coordinated consumer upgrade.

Until those owner slices pass, the target artifact and generated registry are
machine-contract candidates, not evidence that a new Billing API or charging
flow is live.
