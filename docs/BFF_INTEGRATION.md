# kokoro-billing BFF v1 接入说明

BFF 是统一入口，只调用 Billing v1 API，不直接读取本仓数据库。

- User 请求使用 IAM 解析后的可信 tenant/subject 上下文；Admin 请求使用独立 operator 上下文。
- `GET /v1/commerce/catalog` 与 `POST /v1/billing/checkout` 支持两条互斥认证路径：公共用户 JWT，或由 Billing 校验的 `web-bff` service-auth。BFF 出站必须同时发送 `x-kokoro-service: web-bff`、`x-kokoro-internal-secret`、`Authorization: Bearer <BFF_SERVICE_TOKEN>` 和 `x-kokoro-tenant-id`；checkout 还发送 `x-kokoro-subject`。
- Billing 会在检测到任一内部 marker 后锁定 service-auth 分支；伪造、缺字段或 tenant 不合法不会降级为用户 JWT。`/v1/billing/me/*` 仍只接受用户 JWT。
- 所有 mutation 带 `Idempotency-Key` 和 `request_id`，BFF 透传统一错误码和 retry 语义。
- 重复 checkout 使用同一 tenant、subject、payload 和 `Idempotency-Key` 时由 Billing durable receipt 返回原结果；同一 key 搭配不同 payload 返回 `billing.idempotency_conflict`（409）。Redis 只作冲突快速提示，不是幂等事实来源。
- Credit 查询使用 opaque cursor；Payment webhook 只进入 inbox，结算、履约和 Credit 发放由本仓 worker 完成。
- Scheduler 只触发 Billing 暴露的业务任务，Scheduler 不理解 Credit 规则。

契约见 [`API_CONTRACT.md`](API_CONTRACT.md)，Billing owner 的 contract 是本服务 wire authority，跨仓消费者使用版本化契约发布物。
