# kokoro-billing 当前状态

更新时间：2026-09-10。当前规范化分支为 `codex/billing-ts-prisma-alignment`；最终验收必须绑定交付时的 `HEAD`、
干净工作树和当次命令输出，不能继承历史报告。

本文中的“已实现”表示可在当前源码、Schema、contract 与测试中定位；不表示已获得生产流量、SLO、容量或灾难恢复证据。

## 当前规范化工作

- B8-G总门审计已汇总至唯一任务板：Nest依赖/模块与生产Prisma调用仍缺失，完整重写门尚未通过；B9a契约裁决必须前置B8，已纠正计划中的循环依赖。新增主动退款/复杂商品功能不自动扩入原Goal；现有退款/订阅正确性与工程收敛仍全部保留。
- 当前本地消费者为Web→BFF→Billing catalog/checkout：稳定purchase-intent key缺失、Billing201与BFF机器200不一致、Billing artifact未固定，均待owner新major后同切；未以本地负检索推断仓外无人调用。真实收费数据/仓外消费者及订阅发放policy已询问未决。
- 本轮无DB `pnpm verify` 实跑format/lint/typecheck/build/SQL/17route及Prisma生成通过，507测试通过、158集成跳过、0失败；不是全套集成/新运行时验收，日志与基线见任务板。

- B8-D2d订阅身份/账单证据/两阶段Credit发放机制已获数据Astra/TS Sol R2局部放行，首轮2P2（未来周期状态、无webhook补查）闭环。商业资格已向用户询问，未按active/trialing默认当收款；12个本地真实解析签名场景由Root复验，生产metadata/周期/发放代码仍未修，三表与query变化仍是目标。

- B8-D2c退款内部设计已获数据Astra/TS Sol R2审查放行（首轮1P1/2P2闭环），并非实现放行：渠道观察与Credit效果分阶段、Refund.id去重、账户/付款精确关联、比例零delta和held保护。当前parser真实本地签名16场景复现非成功状态被归成功、累计金额/身份fallback及字符串金额放大；Root重跑通过。生产代码未修，详情见任务板；不是Stripe sandbox。

- B8-D2b已完成当前付款/退款HTTP终态核查，未修复链路：真实runtime/认证/PG及原支付worker CLI中，3入口首次和两种重放共9次202，只落付款/退款事实和成功receipt；3条Recorded事件两次worker均未领取。显式owner fulfillment作为fixture建立1000000 micros余额后，300+200 minor退款仍未扣回Credit。接口接受、provider退款完成与Credit效果不可混称，详细证据见任务板。
- 同轮机器契约核查：两个refund入口缺requestBody且202仍为泛型；现有17操作没有Checkout/付款/退款终态GET。allocation_mode当前只进入reason前缀，未执行分配算法。这些是待设计/实现缺口，不据此按金额猜授信规则或自动发起外部退款；v1/SQL/生产源码本轮保持原样。

- B8-D2a Checkout持久claim/事务外调用/fenced finalize、历史unknown、恢复预算与账户/会话维度已通过数据/TS独立设计审查；首轮1P1/2P2闭环。Root用合法配置的真实SDK+本地HTTP故障服务器复现总deadline后继续请求/迟到成功，精确证据见任务板；不是Stripe sandbox。Undici8.10.2仅传输候选，未安装；原持锁调用与背景请求仍待生产替换，完整API/Schema/数据演进未放行。

- B8-S0已实现Stripe一次性付款paid-only门：两种Checkout事件只有payment/paid且subscription缺省或NULL才允许发放。旧源码在独占PG真实回调链中复现unpaid提前创建settlement/account/grant/journal各1；修复后的完整665测试/158集成零失败零跳过，双审通过，精确冻结hash与Root命令见任务板。提交后仍须干净HEAD复验；不是Stripe sandbox或生产流量证据。
- Stripe完整接入仍有缺口：创建Subscription的metadata与本仓回调所需teamId/planId不匹配，现代item-level周期被解析为NULL；这些为本地适配器探针证据，尚未修复。Checkout事务外调用/未知结果恢复、API版本和provider sandbox仍待后续。用户“staapi”平台名称仍待澄清。

- B8-D1七模块DAG、共享writer、35表映射、usage-hold绑定、inbox fence与rollback-only事务已通过数据/TS独立设计审查；仅文档交付，不授权生产重写。B8-D2的major/消费者、202终态和Checkout恢复仍有未决项。

- B7d实现`0f0e7647d4531e94b2a1d7d8858e970850000c6e`：固定Prettier3.9.6，format:check为verify首门；142文件一遍、4文件两遍机械收敛，两个旧文本检查器补格式前后反例。双审及Root冻结树完整443全套/157集成、0失败0跳过，Schema/Prisma零漂移，源码/dist smoke与audit0；干净ce5b628再次完整443/157、0失败0跳过，见任务板。

- B7c已验收8fbf8e0：真实TS AST/resolver依赖门取代禁modules/强制ports，含80正反例和静态export来源追踪；双独立审查/Root冻结代码全验433全套、157集成、0跳过，catalog/Prisma无差异、源码/dist smoke和audit0。干净HEAD46dc851再次完整433/157、0跳过；精确命令/清理见任务板。
- B8新增实证P1：不同key并发pricing发布争用revision（23505）；outbox持久payload解码失败在try外，maxAttempts=1后仍可第二次claim而不死信。独占PG复现已记录，尚未修复。
- UUID数据库切换涉及现有v1接受的非UUID资源ID，B9契约设计必须前置B8业务重写；线上数据/仓外消费者状态已询问，未据空GitHub发布记录作假设。

- B7b已验收，交付3fd97f56bee0c4aff8f0a095b9c9af164fc3e7fb；双独立审查及Root干净HEAD复验354全套/157integration、0跳过，Schema/Prisma无差异，源码/dist smoke通过，audit0：TS6.0.3、typescript-eslint8.69.0、ESLint10.10.0，全手写typed规则；原8.70候选因安装时发布冷却期失败而未采用，无豁免。见唯一任务板。
- **P0待修（B8）**：默认UUID hold生成hold:${UUID}共41字符usage event ID，超过canonical VARCHAR(36)，真实扣款路径报SQLSTATE22001并回滚；B7b短ID边界fixture不是完整capture成功证据。

- B7a已实现Node24.20.0统一、Vitest5/Vite8、精确依赖及engineStrict，CI/release补齐catalog与Prisma门；审计0漏洞。交付058bdf3，Root干净HEAD318项全套与137项integration通过，源码/dist HTTP smoke通过；精确证据见任务板。生产仍Fastify/pg；typed lint与AST已有后续切片证据，格式已有B7d交付，完整业务迁移仍待B8。
- 唯一任务板：[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)；最新目标：[ADR-0003](ADR/0003-nestjs-prisma-sql-first-alignment.md)。
- 当前仍为Fastify + pg + Zod3，全局四层不是新代码模板。已撤销子仓AGENTS中的强制四层规则；Nest/Prisma尚未切换。
- B6a固定安装Prisma/client/adapter-pg 7.10.0用于生成链与隔离验证；npm latest实际指向8.0.0-rc.13，未采用预发布。选择SQL-first唯一canonical + generated Prisma；
  不删除CHECK/锁/索引，不保留Prisma读/pg写双轨。生成/隔离事务承接已验收；业务切换前仍需writer公开边界、真实业务事务组及契约门。
- `7a193ba`基线：lint/typecheck/build/sql:check/contract:check通过，17条route parity；无依赖test为84通过/80跳过。
  复用本机PostgreSQL18.4/Redis，用独立临时database执行integration为80通过；全套46文件/164测试通过，0失败0跳过。
  临时库已删除；没有清空共享Redis。该结果不是CI PostgreSQL16、provider sandbox、镜像或生产验证。
- 当前Root topology通过；Root standard和handbook测试存在既有失败，详情与准确数量见任务板，不修改其他owner来制造绿灯。
- B4离线Schema安装保护已实施并经独立审查/主控验证：public-only目标、所有用户namespace非空对象保护、单事务锁、回滚、
  server/client预算与连接错误处理。新增21项真实PG反例；主控全套185通过，独立integration101通过，0失败0跳过；
  build产物HTTP health/ready/401/BFF catalog与SIGTERM smoke通过。交付SHA与命令见任务板。
- B5 全量catalog drift已实现并获数据/TS独立复审放行：35表/368列/127约束/83索引，含partial predicate、locale、persistence、RLS与额外执行对象；
  目标只读，显式管理连接仅创建并清理本轮template0参照库，安全输出差异与未知资源名。交付9663db5，Root在干净HEAD完整217项、integration129项通过，0失败0跳过；命令见任务板。
- B6a生成链与B6b隔离事务承接已验收；Prisma生产承接与Nest仍属B7/B8，见任务板。35表当前writer调查已写入同一任务板，shared receipt/audit/outbox的公开能力仍待设计，不把B5称为整仓规范化完成。

## 已实现

### Owner 与持久化

- Billing 拥有 Payment、Subscription、Checkout、Refund、Credit、Ledger、Metering、Reconcile 和 command receipt。
- `database/schema.sql` 是唯一 V1 Schema，含 35 张 `payment_*` / `entitlement_*` 表；没有 migration 目录、外键或跨仓表。
- `scripts/apply-schema.ts` 通过 `scripts/canonical-schema.ts` 使用 PostgreSQL advisory lock、READ COMMITTED事务与全用户namespace
  空库检查安装Schema。只接受既有public目标，非空关系/type/function拒绝；故障回滚且释放资源，不自动补齐旧库。
- 金额/credit 使用整数列；数据库瞬时点使用 `TIMESTAMPTZ(3)`。

### Durable command authority

- `payment.settlement.accept` 以 `settlement_id` 作为 command identity，并在 `payment_command_receipt` 保存
  `Idempotency-Key`、versioned request digest、状态和 `{settlementId, accepted}` 结果。
- `entitlement.credit-holds.expire` 以 caller 提供的 `batch_id` 作为 command identity，并在
  `entitlement_command_receipt` 保存规范化后的 `limit` digest 与 `{batchId, expiredHoldIds}` 结果。
- 两张 receipt 表均以 `tenant_id + command_name + idempotency_key` 约束 key，以 partial unique index 约束非空
  `tenant_id + command_name + command_identity`。同 identity 换 key 仍重放同一结果；同 key 换 identity 或 payload 返回
  `billing.idempotency_conflict`。
- Expiry replay 读取已持久化的 hold ID 列表，不会重新扫描后续 eligible hold；receipt、hold/allocation/account 与 outbox 在同一
  PostgreSQL use-case transaction 内提交。
- Admission authorize/capture/release 与 execution-event ingress 使用 `entitlement_billing_command_receipt`；scope 是
  `tenant_id + api_surface + command_name + idempotency_key`，业务 identity 分别是 invocation、admission、admission 与 event ID。
  Capture/release 在检查 admission 终态前先 claim/replay receipt，release 的 `invocation_id`、`reason` 与可选 `service_receipt`
  都进入版本化 digest；execution event 的 HTTP `Idempotency-Key` 进入 application 并持久化。
- Receipt claim、业务 effect 与 result 在同一 PostgreSQL transaction 内提交；正常执行不会提交对其他 transaction 可见的 `processing` row。
  Schema 已从通用 entitlement/payment receipt 删除 lease 字段；历史 `failed` 返回 `billing.command_failed`，历史
  `unknown`/`processing` 返回 `billing.command_unknown`，不做无 fence 的 stale reclaim。
- Checkout 先按 `tenant_id + idempotency_key` 锁定并比较 versioned canonical payload digest，再决定 replay；只有新 command 才读取
  当前 catalog。Canonical JSON 递归排序 object key、保留 array 顺序并拒绝非 JSON 值，因此报价后续 disabled 不阻断原结果重放。
- Refund 使用 provider + external reversal reference 作为业务 identity，在 settlement row lock 下通过 receipt `ON CONFLICT`、
  `FOR UPDATE`、digest 比较和 durable result 重放收敛独立连接并发；同一 settlement 的累计退款也被串行校验。
- 所有带 `Idempotency-Key` 的 HTTP mutation 都只把 tenant/route/key 的短 TTL presence marker 作为可丢失 Redis 提示；Redis 不接收
  body/digest，不返回 replay/conflict 裁决。API 和 expiry worker 在 Redis 初始连接或运行中丢失时继续使用 PostgreSQL；readiness
  返回 `redis=degraded` 而不是摘除账务 API。
- 损坏或缺失的 succeeded durable `result_json` 由 persistence boundary 抛出内部不变量；HTTP 固定返回 generic
  `billing.internal_error` 500，结构化 error log 保留内部诊断 code，不把持久化损坏伪装成客户端 400。

### Webhook contract 与 runtime

- 生产 webhook provider 集合固定为 `stripe`、`alipay`、`wechat`；path 在验签前按同一集合校验。
- Stripe 使用 `Stripe-Signature` raw-body header；WeChat 使用 timestamp/nonce/signature headers；Alipay 只接受
  `application/x-www-form-urlencoded` body 内的 `sign` 与 `sign_type=RSA2`，query 或合成 header 不参与验签。
- OpenAPI 不再暴露 fixture `mockSignature`，也不把 Alipay body signature 伪装成 query security scheme；
  `x-kokoro-provider-signatures` 与 `AlipayWebhookForm` 表达 provider-dependent 位置。
- Provider webhook 验签、解析和 account-to-tenant mapping 完成后，才写 `payment_provider_event` 与 `payment_outbox`。

### 运行时与协议

- `src/main.ts` 通过 `src/bootstrap/create-billing-runtime.ts` 装配 PostgreSQL、Redis、provider、auth 与 Fastify。
- Redis hint 初始连接失败不会阻止 runtime 构建；`/readyz` 只以 PostgreSQL 为可服务权威，并把 Redis 状态报告为
  `ok|degraded`。同一 PostgreSQL 数据库可在 Redis 缺失时关闭、重建 runtime 并继续读取 durable receipt/fact。
- OpenAPI 与实现各有 17 个 HTTP operation；非探针 operation 已版本化为 `/v1/**`。
- v1 JSON transport 使用 snake_case 和 `{data, meta}` / `{error, meta}`；`meta.request_id` 由 transport 补齐。
- 用户 JWT、Web BFF service-auth、内部 service secret、admin proxy secret 与 provider signature 是分离的身份入口。
- Payment worker 使用 `FOR UPDATE SKIP LOCKED`、row lease、续租、重试上限与 dead-letter。
- Execution event 先持久化，再由 batch script 调用 admission application path；reconciliation repository 可检查账务 drift。

### 本轮可执行覆盖

- Contract test 固定 capture/release request body、execution-event 409、settlement/expiry body、Idempotency-Key 边界、Redis degraded
  readiness、provider enum 和 webhook signature location。
- HTTP test 固定 capture/release/execution key 与完整 payload 传递、generic 500 result-corruption mapping、等价 JSON 与 Redis timeout
  均继续进入 durable authority，以及真实 Alipay RSA2 form-body 验签。
- Real-PostgreSQL integration 固定 admission command receipt、checkout 递归字段重排/disabled-offer replay/payload drift、refund 双连接
  并发、settlement/expiry identity replay、历史 receipt 状态和损坏 result；runtime integration 固定 Redis 缺失下的启动与重启。
- Architecture/SQL gate 固定 canonical Schema、无 FK、receipt identity index、依赖方向与 route metadata。

## 下一阶段目标

- 补齐其余 mutation 的精确 request/response/error Schema，并建立 OpenAPI 与运行时 validator 的系统化 semantic parity。
- 对最后发布 artifact 执行自动 OpenAPI breaking comparison，并发布机器可读 provenance manifest。
- 为 reconciliation、execution-event lag、provider error、receipt conflict 与账本不变量提供部署入口、metrics、dashboard 和 alert。
- 在候选生产环境验证 PostgreSQL/Redis 故障、worker crash/lease loss、重放、备份恢复与回滚。

## 已知缺口

1. **其余 OpenAPI shape coverage**：capture/release request 与 execution conflict 已闭环；refund、subscription 等 surface 仍有
   generic response 或不完整 error/body 描述。
2. **Breaking/provenance automation**：没有 historical semantic diff 与机器 provenance publish job；当前以 Git commit/tag +
   OpenAPI SHA-256 固定来源。
3. **Ledger wire time**：`V1LedgerEntry.created_at` 与 adapter 使用 Unix epoch milliseconds；平台目标是 RFC 3339 UTC。
4. **Reconciliation deployment**：repository/service 与 integration test 已存在，但没有独立 CLI/worker、schedule、metric 或受审计
   repair command。
5. **Execution worker concurrency**：一次性 batch 没有跨进程 row lease；当前不应并行运行多个实例。
6. **HTTP/provider reliability controls**：尚未统一配置 route rate limit、overall request deadline、response-size limit 与取消传播；
   hosted checkout provider call 当前仍位于 session transaction，尚未拆成带 durable provider-attempt 状态的短事务流程。
7. **Observability completeness**：provider error ratio、execution lag、reconciliation drift、receipt 状态和账本不变量仍缺直接
   metric/alert provisioning。
8. **Retention/DR**：receipt、inbox/outbox、audit、journal 尚无已执行 retention/partition/GC 策略；备份恢复与 RPO/RTO 无仓内实测。
9. **Redis 自动恢复**：Redis 丢失后当前进程 fail-open 并禁用对应 hint/lease 优化；Redis 恢复不会在同一进程自动重新连接，需由
   supervisor 受控重启后恢复优化，但 PostgreSQL command/账务可用性不受此限制。
10. **生产证据**：仓内没有生产 traffic、SLO attainment、容量、故障注入或恢复演练数据；SLO 数值仅为目标。

## 本轮边界

- 不新增跨仓 contract、consumer 修改、migration、兼容 alias、双读双写或 production Fake/InMemory。
- 不改变其他 Billing command 的协议与 owner，不修改其他仓库。
- 本地 PostgreSQL/Redis integration 只证明当前 fixture 行为，不提升为 production readiness 或 SLO 达标声明。

### B6a 生成治理证据（2026-09-08）

Prisma/client/adapter-pg固定7.10.0；SQL仍唯一可编辑Schema，schema/provenance只读提交，Client离线生成。
独立数据/TS复审已放行；Root真实完整门禁54文件228测试通过、0失败0跳过，catalog35表0差异，prisma:check通过，
源码与编译Client均连接隔离PG验证。生产仍Fastify/pg，B6b事务承接与Nest业务切换未完成。
当前审计5项既有vitest/vite/esbuild漏洞待B7；Docker探测超时，未声明镜像/PG16 CI/完整供应链通过。准确命令与提交见任务板。


### B6b 隔离事务承接

已增加Prisma真实事务、回滚、并发唯一性/锁、预算、BigInt/JSON/UTC验证，独立规格/TS复审完成。
修正了key UNIQUE被identity约束掩盖、泛P2010冒充超时以及JavaScript barrier早期失败悬挂等测试缺口。
交付27938824a064893a1d8f201fd3e3c9d8042ce579；Root干净HEAD全套55文件233项、独立integration32文件137项通过，0失败0跳过；catalog与Prisma生成均0差异。
生产仍Fastify/pg，本轮不声称业务writer/Nest已切换；下一切片B7，精确命令及未运行项见任务板。
