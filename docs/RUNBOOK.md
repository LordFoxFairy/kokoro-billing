# kokoro-billing 运行说明

```bash
export DATABASE_URL=TARGET
export REDIS_URL=TARGET
pnpm db:apply-schema
pnpm start
```

默认 API 监听 `127.0.0.1:4245`。`GET /healthz` 为存活检查，`GET /readyz` 检查 PostgreSQL 和 Redis。
Payment 与 Entitlement/Credit 在本仓内分 bounded context；Credit 余额、Hold、Commit、Refund、Ledger 和
账务事实全部由 PostgreSQL 持久化，Redis 只做 lease、cache 和 idempotency hint。

## 告警分诊

1. 用告警中的 `request_id`/`trace_id`、operation、部署版本和 tenant 范围定位结构化日志；不得把 secret、provider
   签名或完整支付载荷复制到工单。
2. 检查 `/readyz`、PostgreSQL 连接/锁等待、Redis 可用性和 worker metrics。Redis hint/lease 故障不得绕过 PostgreSQL
   receipt、行锁或账务事实。
3. 对照 [SLO 与告警基线](SLO.md) 判断 burn rate、队列年龄和账务不变量影响，先停止扩大影响的发布或 worker。

## API 与依赖超时

- API 5xx/延迟升高：按 route 与状态码拆分，确认 PostgreSQL pool、慢查询和 provider 调用；保留原 request ID。
- Redis timeout：确认 connect/read/overall deadline；idempotency hint 可降级，不能删除 PostgreSQL durable receipt。
- shutdown deadline：先从负载均衡摘除实例；若总 deadline 到期由进程强制退出，检查未完成请求与数据库事务。

## Outbox 与 Payment event

- oldest pending 超阈值：暂停非必要发布，检查 worker lease、数据库锁、provider 错误率和 dead-letter。
- 重放只使用原 outbox/event ID 与稳定幂等键；先确认目标没有成功事实，再通过受控 worker/admin command 重试。
- dead-letter 或 provider error 爆发：按 provider/operation 隔离；禁止无幂等键重放支付 mutation。

## Ledger 与对账

- 任一 projection drift、重复序号、跨 tenant 关联或 receipt/journal 不一致立即按 critical 事故处理。
- 保存相关 receipt、journal、hold/grant、settlement/reversal 的只读快照，停止影响 tenant 的新写入并运行 reconciliation。
- 通过拥有相同事务与审计语义的修复 command 更正事实；禁止直接手工更新余额或删除 journal 来消警。
