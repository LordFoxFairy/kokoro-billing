# kokoro-billing 当前状态

更新时间：2026-09-03。业务运行时审阅基线为提交 `9218c38`；当前治理分支只修改文档、OpenAPI metadata、
TypeScript strictness 与架构门禁，不修改业务运行时或 `database/schema.sql`。

本文中的“已实现”表示可在当前源码中定位；不表示已获得生产流量、SLO 或灾难恢复证据。验证结果必须绑定待交付
commit 与当次命令输出，见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。

## 已实现

### Owner 与持久化

- Billing 拥有 Payment、Subscription、Checkout、Refund、Credit、Ledger、Metering、Reconcile 和 command receipt。
- `database/schema.sql` 是唯一 V1 Schema，含 35 张 `payment_*` / `entitlement_*` 表；没有 migration 目录和外键。
- `scripts/apply-schema.ts` 使用 PostgreSQL advisory lock、事务和空库检查安装 Schema。
- 金额/credit 使用整数数据库列；数据库瞬时点使用 `TIMESTAMPTZ(3)`。

### 运行时与协议

- `src/main.ts` 通过 `src/bootstrap/create-billing-runtime.ts` 装配 PostgreSQL、Redis、provider、auth 与 Fastify。
- OpenAPI 与实现当前各有 17 个 HTTP operation；非探针 operation 已版本化为 `/v1/**`。
- v1 JSON transport 使用 snake_case 和 `{data, meta}` / `{error, meta}`；`meta.request_id` 由 transport 补齐。
- 所有 operation 的 contract metadata 标记 owner、`internal-owner` visibility、stability、idempotency 与当前 permission。
- 用户 JWT、Web BFF service-auth、内部 service secret、admin proxy secret 与 provider signature 是分离的身份入口。
- Checkout、admission/capture/release、usage、refund 等写路径有 PostgreSQL 事实唯一性或 receipt；Redis 只作 hint/lease。

### 异步与恢复构件

- Provider webhook 先验证、解析并写 `payment_provider_event` 与 `payment_outbox`。
- Payment worker 使用 `FOR UPDATE SKIP LOCKED`、row lease、续租、重试上限与 dead-letter。
- Execution event 先写 `entitlement_execution_event`，再由 batch script 调用同一 admission application path。
- Hold/grant expiry worker 使用 Redis lease 防止重复调度，账务释放在 PostgreSQL 事务中完成。
- Reconciliation repository 能检查 account、settlement、reversal 和 failed provider event drift。

### 工程门禁

- TypeScript strict 选项显式包含 `useUnknownInCatchVariables`。
- 架构测试检查 clean-slate、依赖方向、SQL 边界、tenant-qualified JOIN、文档/ADR、OpenAPI metadata、供应链与生产 double。
- CI 配置 PostgreSQL/Redis service，执行 Schema 安装、real-infrastructure integration 和 `pnpm verify`。
- Release workflow 在 push 前构建、扫描并 smoke-test candidate；发布 SBOM/max provenance，并对 immutable digest 签名。

## 目标

- 让 OpenAPI 成为完整的字段级 wire authority，并对历史 release 执行自动 breaking comparison。
- 让 reconciliation、execution-event lag、provider error 与所有 SLO 信号都有部署入口、metrics、dashboard、alert 和演练证据。
- 用固定 contract artifact（commit/tag + SHA-256）驱动 BFF/Agent/Model/Scheduler consumer 升级。
- 在生产候选环境验证 PostgreSQL/Redis 故障、worker crash/lease loss、重放、恢复、备份与回滚。

## 已知缺口

1. **OpenAPI shape coverage**：若干 mutation 仍未声明完整 request body/response/error schema，subscription 等响应仍使用
   generic schema；当前 contract gate 校验 route parity、命名、关键边界和治理 metadata，但不是完整 transport semantic diff。
2. **Breaking/provenance automation**：没有历史 OpenAPI breaking-diff 工具，也没有机器可读 provenance manifest；
   `contract/README.md` 记录当前 digest 与人工 consumer 流程。
3. **Ledger wire time**：`V1LedgerEntry.created_at` 与当前 adapter 使用 Unix epoch milliseconds；平台目标是 RFC 3339 UTC。
   本阶段记录差异，不改变 runtime/contract shape。
4. **Reconciliation deployment**：repository/service 与 integration test 已存在，但没有独立 reconciliation CLI/worker、schedule、
   metrics 或修复 command 的发布入口。
5. **Execution worker concurrency**：`process-execution-events.ts` 是一次性顺序 batch，没有跨进程 row lease；并行启动会读取同一批
   received event，当前依赖下游幂等收敛。
6. **HTTP abuse/reliability controls**：尚未显式配置 route rate limit、总体 request deadline、response-size limit 或取消传播策略；
   Fastify/Zod 边界存在，但不等于这些门禁。
7. **Observability completeness**：HTTP 与部分 worker metrics 已实现；provider error ratio、execution-event lag、reconciliation drift、
   receipt 状态和账本不变量仍缺直接 metrics/alert provisioning。
8. **Retention/DR**：Schema 没有已执行的 retention/partition/GC 策略；备份恢复、RPO/RTO 和灾难演练没有仓内实测证据。
9. **生产证据**：仓内没有生产 traffic、SLO attainment、容量、故障注入或恢复演练数据；SLO 数值仅为目标。

## 本阶段不包含

- 不修改业务 handler、application service、repository、provider adapter、worker 行为或 Schema。
- 不新增跨仓 contract、consumer 修改、migration、兼容 alias、双读/双写或 generated artifact。
- 不把本地/CI 通过结果提升为 production readiness 或 SLO 达标声明。
