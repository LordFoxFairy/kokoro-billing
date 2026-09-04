# kokoro-billing 当前状态

更新时间：2026-09-04。当前功能切片为 `codex/billing-durable-command-webhook`；最终验收必须绑定交付时的 `HEAD`、
干净工作树和当次命令输出，不能继承历史报告。

本文中的“已实现”表示可在当前源码、Schema、contract 与测试中定位；不表示已获得生产流量、SLO、容量或灾难恢复证据。

## 已实现

### Owner 与持久化

- Billing 拥有 Payment、Subscription、Checkout、Refund、Credit、Ledger、Metering、Reconcile 和 command receipt。
- `database/schema.sql` 是唯一 V1 Schema，含 35 张 `payment_*` / `entitlement_*` 表；没有 migration 目录、外键或跨仓表。
- `scripts/apply-schema.ts` 使用 PostgreSQL advisory lock、事务和空库检查安装 Schema。
- 金额/credit 使用整数列；数据库瞬时点使用 `TIMESTAMPTZ(3)`。

### Durable settlement 与 expiry command

- `payment.settlement.accept` 以 `settlement_id` 作为 command identity，并在 `payment_command_receipt` 保存
  `Idempotency-Key`、versioned request digest、状态和 `{settlementId, accepted}` 结果。
- `entitlement.credit-holds.expire` 以 caller 提供的 `batch_id` 作为 command identity，并在
  `entitlement_command_receipt` 保存规范化后的 `limit` digest 与 `{batchId, expiredHoldIds}` 结果。
- 两张 receipt 表均以 `tenant_id + command_name + idempotency_key` 约束 key，以 partial unique index 约束非空
  `tenant_id + command_name + command_identity`。同 identity 换 key 仍重放同一结果；同 key 换 identity 或 payload 返回
  `billing.idempotency_conflict`。
- Expiry replay 读取已持久化的 hold ID 列表，不会重新扫描后续 eligible hold；receipt、hold/allocation/account 与 outbox 在同一
  PostgreSQL use-case transaction 内提交。
- Settlement 与 expiry HTTP route 不使用 raw-body Redis fingerprint 作为冲突裁决，避免 JSON 字段顺序和默认 `limit` 表达差异
  覆盖 PostgreSQL 的规范化 digest。Redis 仍只承担其他入口的短期提示和 worker lease。

### Webhook contract 与 runtime

- 生产 webhook provider 集合固定为 `stripe`、`alipay`、`wechat`；path 在验签前按同一集合校验。
- Stripe 使用 `Stripe-Signature` raw-body header；WeChat 使用 timestamp/nonce/signature headers；Alipay 只接受
  `application/x-www-form-urlencoded` body 内的 `sign` 与 `sign_type=RSA2`，query 或合成 header 不参与验签。
- OpenAPI 不再暴露 fixture `mockSignature`，也不把 Alipay body signature 伪装成 query security scheme；
  `x-kokoro-provider-signatures` 与 `AlipayWebhookForm` 表达 provider-dependent 位置。
- Provider webhook 验签、解析和 account-to-tenant mapping 完成后，才写 `payment_provider_event` 与 `payment_outbox`。

### 运行时与协议

- `src/main.ts` 通过 `src/bootstrap/create-billing-runtime.ts` 装配 PostgreSQL、Redis、provider、auth 与 Fastify。
- OpenAPI 与实现各有 17 个 HTTP operation；非探针 operation 已版本化为 `/v1/**`。
- v1 JSON transport 使用 snake_case 和 `{data, meta}` / `{error, meta}`；`meta.request_id` 由 transport 补齐。
- 用户 JWT、Web BFF service-auth、内部 service secret、admin proxy secret 与 provider signature 是分离的身份入口。
- Payment worker 使用 `FOR UPDATE SKIP LOCKED`、row lease、续租、重试上限与 dead-letter。
- Execution event 先持久化，再由 batch script 调用 admission application path；reconciliation repository 可检查账务 drift。

### 本轮可执行覆盖

- Contract test 固定 settlement/expiry body、response、provider enum 和 webhook signature location。
- HTTP test 固定 batch/key 传递、缺失 batch 拒绝、Redis raw-body false conflict 回归、unsupported provider 拒绝及真实 Alipay RSA2
  form-body 验签。
- Real-PostgreSQL integration 固定 receipt replay、request drift conflict、并发 settlement、identity replay、同 key 下一批拒绝及
  expiry 不消费后续 hold。
- Architecture/SQL gate 固定 canonical Schema、无 FK、receipt identity index、依赖方向与 route metadata。

## 下一阶段目标

- 补齐其余 mutation 的精确 request/response/error Schema，并建立 OpenAPI 与运行时 validator 的系统化 semantic parity。
- 对最后发布 artifact 执行自动 OpenAPI breaking comparison，并发布机器可读 provenance manifest。
- 为 reconciliation、execution-event lag、provider error、receipt conflict 与账本不变量提供部署入口、metrics、dashboard 和 alert。
- 在候选生产环境验证 PostgreSQL/Redis 故障、worker crash/lease loss、重放、备份恢复与回滚。

## 已知缺口

1. **其余 OpenAPI shape coverage**：settlement 与 expiry 已闭环；refund、admission/release、subscription 等 surface 仍有 generic
   response 或不完整 error/body 描述。
2. **Breaking/provenance automation**：没有 historical semantic diff 与机器 provenance publish job；当前以 Git commit/tag +
   OpenAPI SHA-256 固定来源。
3. **Ledger wire time**：`V1LedgerEntry.created_at` 与 adapter 使用 Unix epoch milliseconds；平台目标是 RFC 3339 UTC。
4. **Reconciliation deployment**：repository/service 与 integration test 已存在，但没有独立 CLI/worker、schedule、metric 或受审计
   repair command。
5. **Execution worker concurrency**：一次性 batch 没有跨进程 row lease；当前不应并行运行多个实例。
6. **HTTP abuse/reliability controls**：尚未统一配置 route rate limit、overall request deadline、response-size limit 与取消传播。
7. **Observability completeness**：provider error ratio、execution lag、reconciliation drift、receipt 状态和账本不变量仍缺直接
   metric/alert provisioning。
8. **Retention/DR**：receipt、inbox/outbox、audit、journal 尚无已执行 retention/partition/GC 策略；备份恢复与 RPO/RTO 无仓内实测。
9. **Redis startup availability**：Redis 不是账务事实源，但 API/expiry worker 当前启动与 readiness 仍要求 Redis 连接；运行中部分
   hint/lease 操作可降级不等于启动完全解耦。
10. **生产证据**：仓内没有生产 traffic、SLO attainment、容量、故障注入或恢复演练数据；SLO 数值仅为目标。

## 本轮边界

- 不新增跨仓 contract、consumer 修改、migration、兼容 alias、双读双写或 production Fake/InMemory。
- 不改变其他 Billing command 的协议与 owner，不修改其他仓库。
- 本地 PostgreSQL/Redis integration 只证明当前 fixture 行为，不提升为 production readiness 或 SLO 达标声明。
