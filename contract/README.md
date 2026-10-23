## CREDIT-1：正式sealed结算（2026-10-22，候选）

唯一canonical为4.0.0-experimental.9，28 operations／57 schemas；SHA256 `7b5335fde2be601b2d6256cb9b68b0964d5518cfa053b50f2029358a059a0924`。
新增BFF本人机器上下文的POST admissions/{admission_id}/settle，由owner决定capture／release／pending，
删除未挂载的两个旧capture/release命令和两旧request schema，不保handler／wire alias。
Run与原Admission先核等；strict原证据引用，原永久ACK以整Credit字符串公开，不外露evidence JSON。
exp9→8 build/test-only逆证明完整还原原SHA，再沿既有whole-source链核不相关操作；正常尚未激活。

## 当前精确模型选价绑定候选（2026-10-22）

canonical 4.0.0-experimental.8，29操作／56schema；SHA256 `2c65b64c896a85cb89e6b8f23ee9802b6e5cf2440d9a8debaa23973f5c199b6e`。Admission POST/GET 改为真实整次预算资源：BFF 完整 u1 身份、独立消费授权、六项 preparation 绑定；POST 回放原始 held，GET 当前金融状态。移除旧未实现的成本上界与复合伪状态；无运行时兼容。原 MeteringRate 的精确 model_revision、rate2/policy2 保持。选择消费可信prepared精确技术pair，同一次active rate读取得出并冻结商业映射，不接受Agent自报价目身份；无新表／服务／API／默认商业值。正常尚未激活，消费者待固定本发行。

构建/测试的具名inverse逐字恢复整个exp5（SHA8005cff204976ca681653565fb8b6b098bc195cc70049743f70ae85989df35ab），再承接原26操作/45schema inverse。它不是runtime兼容；旧无技术绑定rate1拒绝。下方记录仅历史，不能覆盖本节当前版本。

## 当前计价管理候选（2026-10-22）

canonical 4.0.0-experimental.5，29操作／56schema；SHA256 `8005cff204976ca681653565fb8b6b098bc195cc70049743f70ae85989df35ab`。现Metering发布两POST与最新配置RR单体GET；当前协议绑定owner固定，非生效报价，无资金效果。正式生成与精确逆恢复保护旧26操作/45schema；无runtime旧wire回退。源码候选不等于正常部署。

## CREDIT-1：非现金管理员积分发放（2026-10-22，未正常激活）

canonical `openapi/v1/openapi.yaml` 为4.0.0-experimental.4，26 operations／45 schemas；新增POST /v1/admin/billing/credit-grants及严格请求/响应。web-bff当前管理员代理与同tenant接收者资格由BFF核实，Billing另核service bearer/internal secret/operatorProxySecret与u1 tenant/operator；不接受body tenant/actor/role、用户Bearer或旧admin header分支。正常资金未写入，消费者及实际用量结算仍待完整接线；无现金支付。

SHA256 `a09e00a3d6f602fdaff13a50a5a839c8a989b1a26ab28c43eac314738fcfdef2`。唯一canonical正规生成；构建/测试将新funding profile移除后精确还原此前25操作/43schema全部原字节，历史inverse只作保护性oracle，不是runtime兼容或第二份可编辑契约。

## 2026-10-20 PR #2 current integration

Canonical `openapi/v1/openapi.yaml` advances to `4.0.0-experimental.3`: 25 operations / 43 schemas. `PUT /v1/billing/me/credit-account` reuses the approved machine-only naturally idempotent zero-account command. No `/v2` alias; no grants, journals, payments or schema changes. The exact inverse restores main experimental.2 bytes and runs its unchanged validator. This is an internal lifecycle operation, not a user-facing account-opening step. BFF/App consumption is separate.

SHA256 `f934d6f81842fafaec2e3e64cca6bd4669f86601979bd737941a5695506814fe`.

## 2026-10-19 唯一当前集成候选

canonical `openapi/v1/openapi.yaml`，版本 `4.0.0-experimental.2`；下方旧版本记录仅是历史。组合 main Catalog/u1 和缺账户404、本地 usage2 固定目标；无 /v2 alias、未装配资金写入，正常模型和扣费不启用。当前源码六个 GET（probes、Catalog、本人 Credit 两读）不代表其他目标操作已上线。

SHA256 `9ff84d5f473e2f161f5d0c496db4cee175e2b032e836e97c7e23b9576a0af3e6`。消费者必须固定正式 commit/version/digest 后正规生成。

## 历史 SET49 publication（后继见当前集成）

正规v2推进3.0.0-experimental.5，仅本人两读404专用code变化；Catalog/u1/offer_key保留，v1不可变。消费者必须更新正式commit/digest并正常生成，不以不可取得的v1 pin冒provenance。

## SET-15 Catalog owner候选生成（待Root验收）

当前正规生成源为v2 `3.0.0-experimental.4`，required `offer_key`及canonical u1 catalog transport是明确strict消费breaking；只允许Root按正式owner commit及本页current digest成对刷新消费者。v1历史artifact及其digest未修改。候选正常Nest graph已注册六GET及HEAD，目录只读且不证明checkout、subscriptions或商品发布可用；正式PG/source/dist/浏览器证据仍待Root。

## SET-15 catalog候选裁决（2026-10-13）

本节覆盖下表旧current Fastify已部署状态：正常Nest入口已交付五GET及HEAD。下一canonical catalog候选将现v2 artifact从3.0.0-experimental.3推进为3.0.0-experimental.4，承认required offer_key及catalog身份transport的strict消费breaking；只自有开发成对固定immutable commit/digest，现Credit wire与operation数24不变。三个设计面SET15门为当前方案，catalog未实现/未启动前不宣称部署；历史表格保留作前态，非当前激活证据。不得手改生成物、旧hash或借beta例外。

# kokoro-billing contract governance

## Current machine artifact

[`openapi/v1/openapi.yaml`](openapi/v1/openapi.yaml) is the only editable Billing HTTP machine source: `4.0.0-experimental.9`, exactly 28 operations / 57 schemas (three probes and 25 `/v1/**` operations). No `/v2` alias or second editable source.

```text
openapi/v1/openapi.yaml  7b5335fde2be601b2d6256cb9b68b0964d5518cfa053b50f2029358a059a0924
```

The existing probes, Catalog, personal Credit lifecycle, non-cash administrator grants and pricing configuration remain mounted. Explicit model-admission configuration adds create/get and owner-decided settle; it is not default activation. The other declared payment/execution targets remain unimplemented and unregistered. Candidate HTTP availability is not normal provider execution or actual usage acceptance evidence.

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
payer, trusted producer, trusted subject, final charge, price, rate, multiplier,
or settlement amount for model usage. Durable Admission and ExecutionEvent
representations retain the server-derived producer for audit and replay; it is
not accepted from command bodies. Browser traffic continues through Web and
BFF; an IAM user/BFF authentication alternative does not make this an externally
public contract.

## MC01-B2b exact Agent HTTP consumer

The usage2 consumer receipt now fixes the read-only HTTP7.1 OpenAPI and provenance under `vendor/agent/http/v7/`, from immutable Agent `7e1e068` Git blobs. The old v6 vendor path is removed, not a runtime fallback. The existing generator emits exact sealed/prepared types and separate bounded envelope schemas. Both operations share the existing authenticated reader lifecycle; only pending/current prepared facts can be considered for a new admission. Canonical bytes, ordinary part digests, complete expected binding and arrival-time lease expiry are verified. This read is not a financial permit or hold; existing receipt recovery must not require a live prepared read. Frozen usage2 sources and the original sealed numeric/budget/knowledge semantics remain unchanged.

## Target per-attempt usage contract

The target Admission and Execution shapes bind one physical model attempt. The
identity includes the run/call/attempt lineage, immutable planned binding and
execution bound, and a reference to the Agent-owned strict usage artifact.
Billing pins that artifact rather than copying its schema:

```text
Agent artifact version: 2.0.0
Agent usage schema SHA-256: 552f0d22251837aaf4d83766c7bd91311984f707f9a42950ed53ac7127bb5504
```

The read-only release pointer is `agent/usage/v2/consumer-pin.json`, verified by
`pnpm contract:check` against its accepted immutable digest. It binds Agent
commit `2d5ce12c0eecdecfcdb44a21b69da707d51eb7c7`, HTTP6, and the usage2
schema/manifest/vectors. It is not a runtime reader or billing permission.
Sealed usage1 remains Agent-owned historical evidence; it does not authorize a
new admission or retroactive billing without an original financial snapshot.

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

`contract/openapi/v1/openapi.yaml` is the only editable target machine source.
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
properties disabled. This bootstrap evidence does not mean the 24 target operations are implemented.

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

`contract:check` preserves exact parity for the single 24-operation v1 source. Checks cover OpenAPI syntax, local references, operation IDs and governance,
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

## Distributed Agent usage2 validation kernel

`agent/usage/v2/consumer-pin.json` remains the immutable release receipt. B2a now
also distributes the exact Agent schema, vectors and manifest under
`vendor/agent/usage/v2/`; these are read-only owner artifacts, not editable
Billing schemas. The normal contract command checks all three accepted hashes
and byte-exact generated drift:

```bash
pnpm contract:check
pnpm exec tsx scripts/generate-agent-usage.ts --check
```

After an explicitly approved owner release update, the same generator without
`--check` produces `src/generated/agent-usage-v2/`. Types use the existing pinned
HeyAPI generator; a compiled schema constant keeps the decoder independent of
source/vendor files at runtime. Do not edit generated output or change the
receipt to silence a failed check. The pure Metering kernel validates original
UTF-8 JSON, domain digest, successor knowledge and complete sealed snapshot
binding. It performs no HTTP or database I/O and grants no financial permission;
the authenticated HTTP reader and Admission/settlement remain separate open
implementation work.
