# kokoro-billing contract governance

Target canonical machine source：[`openapi/v2/openapi.yaml`](openapi/v2/openapi.yaml)；当前尚未切换的Fastify运行时继续由字节不变的[`openapi/v1/openapi.yaml`](openapi/v1/openapi.yaml)校验route parity。人类语义见
[`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md)，它不构成第二份字段级 contract。

## Owner

**Owner:** `kokoro-billing`。

本契约只描述 Billing 拥有的 health/readiness/metrics、storefront owner route、credit/subscription read、checkout、
admission/execution、settlement/refund、expiry command、admin refund 与 provider webhook。它不定义 BFF public Product API、
IAM identity、Agent Run、Scheduler schedule 或任何其他仓库的数据库模型。

## Visibility

**Visibility:** `internal-owner`。

目标24个operation与当前17个operation均为 `internal-owner`，只供受信 service、deployment probe/scraper、admin gateway 或已验证 payment
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

**Version:** 目标OpenAPI `info.version=2.0.0`、格式3.1.0，业务route位于`/v2/**`且在runtime/consumer切换前为experimental；当前运行时artifact仍为1.0.0与`/v1/**`。`/healthz`、`/readyz` 与 `/metrics` 是有意
不带版本的运行端点。`package.json` 的 `0.1.0` 是 private implementation version，不替代 wire version。

V1 内只接受 backward-compatible 变更；仅修改 `info.version` 不能使 breaking change 兼容。

## Generation

**Generation:** 当前 OpenAPI YAML 由 Billing owner 在本仓直接维护和 review，不从 TypeScript/Zod 生成。当前没有
`src/generated/` client/server artifact，也没有 contract generation script。

```bash
pnpm contract:check
```

该命令保留v1的17条真实runtime parity，并独立校验v2的24条目标operation、全部本地`$ref`、唯一operationId、tenant/request ID/execution-event 边界、capture/release/settlement/expiry command body、
Idempotency-Key、execution-event 409、Redis degraded readiness、production webhook provider/signature location、全部 operation metadata 与 Fastify route parity。
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
`contract/openapi/v2/openapi.yaml`，当前目标source SHA-256：

```text
eb95b6ddf4c3e611ff3eb065bcb39dad97d47cbf2203f8d6fd8105f17a5b42ad
```

当前未切换v1的固定SHA-256仍为`58fbe4fea083ba12e0db23f49e995b96500d01af0013febf40eba3093510ef63`；M1b不修改其字节。

复核：

```bash
shasum -a 256 contract/openapi/v2/openapi.yaml
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

当前 `contract:check` 能证明v1运行route parity，以及v2 YAML可解析、本地ref闭合、24条operation治理、typed command/resource结果、唯一Execution 202、201/202 Location、UUID/opaque边界、request-id与caller authority禁用字段、provider ACK差异；它不能证明v2与尚未切换的运行时
Zod逐字段相等。runtime parity、consumer pin与真实provider sandbox仍需在后续实现切片闭合，详见
[`../docs/CURRENT.md`](../docs/CURRENT.md)。
