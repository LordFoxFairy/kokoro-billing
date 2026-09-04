# kokoro-billing contract governance

Canonical machine source：[`openapi/v1/openapi.yaml`](openapi/v1/openapi.yaml)。人类语义见
[`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md)，它不构成第二份字段级 contract。

## Owner

**Owner:** `kokoro-billing`。

本契约只描述 Billing 拥有的 health/readiness/metrics、storefront owner route、credit/subscription read、checkout、
admission/execution、settlement/refund、expiry command、admin refund 与 provider webhook。它不定义 BFF public Product API、
IAM identity、Agent Run、Scheduler schedule 或任何其他仓库的数据库模型。

## Visibility

**Visibility:** `internal-owner`。

全部 17 个 operation 均为 `internal-owner`，只供受信 service、deployment probe/scraper、admin gateway 或已验证 payment
provider 使用。Storefront route 的 IAM user/BFF alternative 不使本契约成为 Root Developer API 的 `public` surface；
Browser 仍通过 Web/BFF 访问。

每个 operation 声明：

| Extension | 当前值 |
|---|---|
| `x-kokoro-owner` | `kokoro-billing` |
| `x-kokoro-visibility` | `internal-owner` |
| `x-kokoro-stability` | `stable` |
| `x-kokoro-idempotency` | `inherent`、`read-only`、`required` 或 `provider-event-id` |
| `x-kokoro-permission` | 与当前 route auth/allow-list 对齐的精确值 |

## Version

**Version:** OpenAPI `info.version=1.0.0`，业务 route 位于 `/v1/**`。`/healthz`、`/readyz` 与 `/metrics` 是有意
不带版本的运行端点。`package.json` 的 `0.1.0` 是 private implementation version，不替代 wire version。

V1 内只接受 backward-compatible 变更；仅修改 `info.version` 不能使 breaking change 兼容。

## Generation

**Generation:** 当前 OpenAPI YAML 由 Billing owner 在本仓直接维护和 review，不从 TypeScript/Zod 生成。当前没有
`src/generated/` client/server artifact，也没有 contract generation script。

```bash
pnpm contract:check
```

该命令校验 OpenAPI 版本、tenant/request ID/execution-event 边界、capture/release/settlement/expiry command body、
Idempotency-Key 与 execution-event 409、production webhook provider/signature location、全部 operation metadata 与 Fastify route parity。
HTTP runtime 仍由手写 Zod/mapper 实现；生成物若未来引入，
只能从本 source 生成到明确的 read-only directory，并在同一 commit 校验 drift。

## Breaking policy

**Breaking policy:** 以下变化不得在 V1 原位进行：删除/重命名 path、method、header、request/response/error 字段，收紧已接受约束，
改变 auth/tenant/idempotency/cursor 语义，或改变 governance extension 含义。Breaking change 需要新 major API version、owner
review、consumer migration、并行窗口与明确退役条件。

兼容性流程：

1. 与最后发布的 immutable contract artifact 比较；
2. 先改 Billing owner source；
3. 运行 syntax/governance/route/transport checks；
4. 同 commit 更新实现、测试和人类策略文档；
5. 发布固定 commit/tag + digest；
6. consumer 显式升级并运行 integration/smoke。

当前没有 automated historical OpenAPI breaking-diff tool；review 与版本纪律仍是缺口，governance-key 检查不能替代 semantic
compatibility comparison。

当前 webhook machine contract 只包含 `stripe|alipay|wechat`。Stripe/WeChat 的 header security scheme 与 Alipay 的
form-body `sign`/`sign_type=RSA2` 由 `x-kokoro-provider-signatures` 区分；fixture `mockSignature` 不属于生产 contract。

## Provenance

**Provenance:** repository `https://github.com/LordFoxFairy/kokoro-billing`，source path
`contract/openapi/v1/openapi.yaml`，当前 source SHA-256：

```text
44a804c09d398d1a0a609928dd243998e0aa472a76fc456c1715154b678dfa35
```

复核：

```bash
shasum -a 256 contract/openapi/v1/openapi.yaml
git rev-parse HEAD
```

Digest 只标识当前 contract bytes；consumer 还必须记录包含它的 immutable Git commit/tag。当前没有机器可读 provenance manifest，
也没有独立 contract artifact publish job。修改 source 时必须同步更新本节 digest；`pnpm contract:check` 会阻止 digest 漂移。

## Consumer workflow

Consumer 固定以下 tuple：

```text
repository
git commit or immutable tag
source path
OpenAPI info.version
SHA-256
```

升级步骤：

1. 获取 Billing 发布的固定 artifact/commit，不跟随 mutable branch；
2. 校验 SHA-256 与 `info.version`；
3. 生成或更新 consumer-local read-only client/type；不得复制手写 DTO 或导入 Billing repository/Schema；
4. 审查 operation permission、tenant、Idempotency-Key、error code、cursor 与 timeout；
5. 运行 consumer contract test、Billing integration 与端到端 smoke；
6. 保留 rollback 所需的前一固定 artifact，直到 rollout 与账务 reconciliation 完成。

BFF 只将 Billing 数据投影到自己的 public Product API，不得把本 internal contract 原样发布；Agent/Model/Scheduler 只消费各自
allow-list 内的 operation。

## Validation scope and gaps

当前 `contract:check` 能证明 YAML 可解析、capture/release/settlement/expiry shape、execution-event 冲突状态、
Idempotency-Key、webhook provider/signature、核心禁用字段、metadata 与 route 集合；它不能证明所有 request/response 与运行时
Zod 逐字段相等。其余 mutation body、generic response、错误集合与 ledger time format 仍需在后续 contract-first 变更中补齐，详见
[`../docs/CURRENT.md`](../docs/CURRENT.md)。
