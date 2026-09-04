# ADR-0002：Billing 拥有 internal-owner V1 OpenAPI

- Status：Accepted
- Date：2026-09-03
- Owner：kokoro-billing

## Context

Root 不拥有跨仓业务 contract。Billing 同时服务 BFF、Agent/Model/Studio、Payment worker、Scheduler、admin gateway 与 payment
provider；若各 consumer 手写 DTO 或从运行时实现猜测协议，会形成多份事实源。Billing 又不是 Developer Product API owner，不能
把内部 owner route 误标为 public。

## Decision

1. `contract/openapi/v1/openapi.yaml` 是 Billing HTTP 字段级 machine source。
2. 全部 operation visibility 为 `internal-owner`；storefront user/BFF route 和 provider webhook 也不进入 Root public portal。
3. 每个 operation 显式声明 owner、visibility、stability、idempotency 与 permission metadata。
4. 非运行探针 route 使用 `/v1/**`；V1 breaking change 进入新 major version 和 consumer migration。
5. Consumer 固定 repository + immutable commit/tag + path + `info.version` + SHA-256；generated client/type 只读且不得成为
   Domain/DB model。
6. Repository contract gate 同时检查核心边界、metadata 与 Fastify route parity。

## Consequences

- Contract 变更先于实现与 consumer，且同 commit 更新测试/文档。
- BFF 可以把结果映射到自己的 public Product API，但不能原样发布 Billing internal contract。
- Provider ingress 的 permission 用 signature 表达，幂等由 provider event identity 表达。
- 当前仍缺 historical semantic breaking diff、机器 provenance manifest 和完整 request/response parity；这些缺口必须在
  `docs/CURRENT.md` 保持可见。

## Evidence in current source

- `contract/openapi/v1/openapi.yaml`；
- `contract/README.md`；
- `scripts/verify-openapi.ts`；
- `test/architecture/ownership.test.ts`。
