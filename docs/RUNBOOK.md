# kokoro-billing Runbook

本文覆盖当前已实现的 API、payment event worker、execution event batch、credit expiry 与 PostgreSQL/Redis 故障。命令中的
TARGET/HOST/PORT/TOKEN/DATABASE/TENANT 是 fixture 占位符；不得指向未确认环境。

## 1. 启动前检查

要求 Node.js 22、`pnpm@11.25.0`、Billing 专用空 database（首次安装）和共享 Redis logical DB `4`。

```bash
cd /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing
pnpm install --frozen-lockfile
export DATABASE_URL=postgresql://USER:TOKEN@HOST:PORT/DATABASE
export REDIS_URL=redis://HOST:PORT/4
export INTERNAL_SERVICE_SECRET=TOKEN
export BILLING_BFF_SERVICE_TOKEN=TOKEN
export BILLING_OPERATOR_PROXY_SECRET=TOKEN
export BILLING_AUTH_MODE=internal-header  # 仅本地 fixture
pnpm db:apply-schema
pnpm dev
```

生产必须设置 `NODE_ENV=production`、`BILLING_AUTH_MODE=jwks`、JWKS URL、独立 secrets 与所启用 provider 配置。Schema installer
只运行一次且只接受空 database；不要对已有 Billing 表重复执行。

编译产物启动：

```bash
pnpm build
node dist/src/main.js
```

## 2. 健康、就绪与指标

默认端口：

- API：`127.0.0.1:4245`；
- payment worker metrics：`127.0.0.1:9095`；
- expiry worker metrics：`127.0.0.1:9096`。

```bash
curl --fail --silent --show-error http://HOST:4245/healthz
curl --fail --silent --show-error http://HOST:4245/readyz
curl --fail --silent --show-error http://HOST:4245/metrics
curl --fail --silent --show-error http://HOST:9095/metrics
curl --fail --silent --show-error http://HOST:9096/metrics
```

`/healthz` 只证明进程响应；`/readyz` 同时 ping PostgreSQL 与 Redis。Redis 虽不是账务事实源，但当前 API readiness 仍会在 Redis
不可用时返回 503。

## 3. Worker 启动

```bash
# Payment outbox：持续运行；ONCE=true 可做单次受控验证
DATABASE_URL=$DATABASE_URL node dist/scripts/process-payment-events.js

# Execution event：一次性 batch，当前不要并行运行多个实例
DATABASE_URL=$DATABASE_URL node dist/scripts/process-execution-events.js

# Hold/grant expiry：默认一次；DAEMON=true 持续运行
DATABASE_URL=$DATABASE_URL REDIS_URL=$REDIS_URL node dist/scripts/expire-credit-holds.js
```

部署由外部 supervisor 负责 restart/backoff。记录 image digest、commit、config revision 与启动时间。

## 4. 通用分诊

1. 记录告警时间、部署 digest、operation、request_id/trace_id、provider/queue 与影响 tenant 范围。
2. 检查 health/ready、PostgreSQL connection/lock、Redis、provider 与 worker metrics。
3. 对比最近 deploy/config/secret/provider change；先停止扩大影响的 rollout 或重复 worker。
4. 只做 tenant-scoped read-only 查询并保存 receipt/journal/inbox/outbox 快照。
5. 判断是 availability、延迟、queue lag、unknown result 还是账务不变量事故。
6. 任一 drift、重复 journal sequence、跨 tenant 关联或 receipt mismatch 立即按 critical 处理。

不得把 secret、Authorization、provider signature、完整 payment payload/receipt 或用户身份复制到工单。

## 5. PostgreSQL 不可用或锁等待

症状：ready 503、5xx 增长、pool timeout、worker 无进展。

- 确认 database endpoint、TLS/credential、connection count、long transaction 与 lock wait。
- 从负载均衡摘除不健康 API；暂停领取新 worker work，但不要删除 inbox/outbox。
- 不降级到 Redis/内存，不新建第二个临时 Billing database。
- 恢复后使用原 Idempotency-Key/event ID 重放，先核对 receipt/事实是否已成功。
- 运行 reconciliation read，确认 account/settlement/reversal/provider event 无 drift。

当前仓库未提供 production reconciliation CLI；需要由受控 operator tooling 调用现有 repository/service。在该入口交付前，升级给
Billing owner，不执行临时 UPDATE。

## 6. Redis 不可用

- API readiness 当前会失败；idempotency hint 本身 fail-open 到 PostgreSQL。
- Expiry lease 获取失败时实现会继续 sweep，正确性依赖 PostgreSQL row lock/status；避免人为启动大量并发 sweep。
- 检查 URL 是否明确为 `/4`、connect/read/overall timeout 与网络。
- 恢复后不需要从 Redis 回填账务数据；不要把 Redis key 当作 receipt。
- 若 API 因 readiness 被摘除，Redis 恢复后重新检查 ready 与 PostgreSQL fact。

## 7. Payment provider / inbox / outbox

只读队列检查示例：

```bash
psql "$DATABASE_URL" -v tenant=TENANT <<'SQL'
SELECT provider_event_id, provider, external_event_id, processing_status,
       processing_attempts, received_at, processed_at
FROM payment_provider_event
WHERE tenant_id = :'tenant'
ORDER BY received_at, provider_event_id
LIMIT 100;

SELECT outbox_id, event_type, attempts, next_attempt_at, lease_until,
       published_at, dead_lettered_at
FROM payment_outbox
WHERE tenant_id = :'tenant'
ORDER BY created_at, outbox_id
LIMIT 100;
SQL
```

- Signature failure/tenant mismatch：检查 provider account mapping、endpoint secret/certificate 与 raw-body preservation；不绕过签名。
- Pending age 增长：检查 worker、lease owner、database lock、provider errors 与 max attempts。
- `lease_lost`：原 worker 不应写 published；确认新 owner 是否接管。
- Dead-letter：保存 event/outbox/receipt/settlement 只读证据，确认目标 side effect 是否已发生，再用原 event identity 通过受控工具重放。
- 当前没有发布的 admin replay CLI/HTTP route；不要手工清零 attempts、删除 event 或改 `published_at` 消警。

## 8. Execution event / admission

```bash
psql "$DATABASE_URL" -v tenant=TENANT <<'SQL'
SELECT event_id, invocation_id, execution_id, event_type, status,
       occurred_at, processed_at
FROM entitlement_execution_event
WHERE tenant_id = :'tenant'
ORDER BY occurred_at, event_id
LIMIT 100;

SELECT admission_id, invocation_id, mode, status, hold_id,
       accepted_at, created_at, updated_at
FROM entitlement_billing_admission
WHERE tenant_id = :'tenant'
ORDER BY created_at, admission_id
LIMIT 100;
SQL
```

- `execution.unknown` 保留 hold；不要推断成功或失败。
- 只有受信 accepted receipt 才 capture；明确 rejected/failed 才 release。
- Batch 失败会保留 event 供后续运行；复用原 event/Idempotency identity。
- 当前 batch 无 row lease，避免并行实例；重复处理由 event/admission/usage 幂等事实收敛，但仍需监控冲突。

## 9. Credit、ledger 与 drift

```bash
psql "$DATABASE_URL" -v tenant=TENANT <<'SQL'
SELECT credit_account_id, subject_id, available_micros, held_micros, generation, status
FROM entitlement_credit_account
WHERE tenant_id = :'tenant'
ORDER BY credit_account_id;

SELECT journal_id, credit_account_id, journal_seq, entry_kind,
       amount_micros, source_kind, source_ref, created_at
FROM entitlement_credit_journal
WHERE tenant_id = :'tenant'
ORDER BY credit_account_id, journal_seq, journal_id;
SQL
```

任一 projection drift：

1. 暂停影响 tenant 的新 admission/credit mutation；
2. 保存 account、grant、hold/allocation、journal、usage settlement、receipt 与 outbox 快照；
3. 检查最近 worker/deploy 与 transaction failure；
4. 运行受控 reconciliation 并由 Billing owner判定 repair command；
5. 修复必须写新的可审计事实并重跑 reconciliation。

禁止直接改 balance、删除 journal、重排 sequence 或释放 hold 来让告警消失。

## 10. Secret 泄漏

1. 隔离受影响 route/workload并停止使用泄漏 credential；
2. 在 secret manager 轮换对应 BFF/internal/admin/provider/Stripe/WeChat secret；
3. 更新 producer 与 Billing，滚动重启并验证 health/ready/auth negative tests；
4. 检查日志、trace、ticket、provider dashboard 与 audit record 的暴露窗口；
5. 重放窗口内的异常 internal/admin/provider event，检查跨 tenant 与重复 payment；
6. 记录 credential version 与撤销时间，不在 incident 文档保存 secret 值。

当前 logger redaction 未显式列出 admin proxy header，泄漏调查必须包括日志 pipeline。

## 11. Shutdown 与回滚

- 发布前先从负载均衡摘除 API；发送 SIGTERM，等待当前请求与 resource close，默认 deadline 10 秒。
- Worker 先停止领取新 work，再等待当前 handler 到 loop 边界；确认 lease/pending row 可被接管。
- 应用回滚使用已签名的 immutable image digest，并保留 contract/Schema 兼容性检查。
- V1 没有 down migration；`db:apply-schema` 不是 rollback 工具，也不会修复 drift。
- 若发布包含 Schema/contract breaking change，应按预先审核的 owner/consumer rollout 执行；当前治理阶段没有这类变更。
- 回滚后检查 ready、error rate、queue age、receipt replay 与 reconciliation，不以进程启动作为完成证据。

## 12. 事故结束条件

- availability/latency/queue 指标回到目标窗口；
- 所有 unknown/dead-letter 有明确 owner 与后续动作；
- affected tenant 的 receipt、journal、hold、settlement/reversal 与 reconciliation 无 drift；
- secret/provider 事件完成必要审计；
- timeline、根因、恢复证据、缺失 telemetry 和 corrective action 已记录；
- 生产数据只来自实际 dashboard/query，不使用本地 fixture 填充 SLO。
