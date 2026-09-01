# kokoro-billing BFF v1 接入说明

BFF 是统一入口，只调用 Billing v1 API，不直接读取本仓数据库。

- User 请求使用 IAM 解析后的可信 tenant/subject 上下文；Admin 请求使用独立 operator 上下文。
- 所有 mutation 带 `Idempotency-Key` 和 `request_id`，BFF 透传统一错误码和 retry 语义。
- Credit 查询使用 opaque cursor；Payment webhook 只进入 inbox，结算、履约和 Credit 发放由本仓 worker 完成。
- Scheduler 只触发 Billing 暴露的业务任务，Scheduler 不理解 Credit 规则。

契约见 [`API_CONTRACT.md`](API_CONTRACT.md)，根仓 contract 是跨仓唯一 wire authority。
