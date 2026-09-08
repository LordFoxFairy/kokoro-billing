# kokoro-billing 验收矩阵

验收必须在待交付 commit 的干净工作树上重新执行。历史报告、旧 CI、Agent 自报、被 skip 的 integration 和本地 fixture
均不等于生产证据。

## 2026-09-08 B5 catalog 验收切片

`pnpm db:verify-schema` 必须在 canonical 正例退出0、缺CHECK/同名partial predicate漂移退出1，并保持目标数据不变。
覆盖全catalog、只读identity与同名用户函数反例、只读角色、locale、额外对象、连接终止/JS deadline、falsey rejection、CLI秘密脱敏与嵌套资源错误。
主控在独占临时database运行完整verify/integration；实际计数、SHA与Root既有失败见唯一任务板。
本地PG18.4不替代尚未执行的PG16 CI；不比较数据/ACL/统计，不声明Prisma/Nest迁移或生产可靠性已完成。

## 2026-09-08 B4 安装保护切片

当前允许范围由[IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md)确定；以下旧durable-command矩阵保留作回归基线，不再授权
对所有application/SQL/HTTP进行修改。本轮仅安装入口/安装用例、新integration及必要文档；没有改Schema、HTTP、业务src或依赖。

B4必须通过：21个独占临时database用例，覆盖fresh35表/重复拒绝、schema全部参数前置拒绝、public缺失/CREATE权限、
所有用户namespace关系与独立type/function/procedure、原对象保留、search_path覆盖、事务回滚、独立client并发、锁超时、
backend终止和JS deadline。业务全套185、独立integration101通过；命令/环境/审查与SHA统一记录在任务板。
完整catalog drift、目标Prisma/Nest、CI16、镜像/provider sandbox与生产DR均不在本次通过范围。

## 1. Durable-command 历史切片范围（回归参考，非当前写入授权）

允许修改：

- admission/capture/release/execution、checkout、settlement/expiry/refund 的 application port、PostgreSQL repository、HTTP adapter 与 worker；
- `database/schema.sql` 中 command receipt identity/state；
- Redis hint/lease 的 fail-open 装配，不引入第二事实源；
- Billing owner OpenAPI、contract checker、architecture/HTTP/integration test；
- 本仓运行、API、数据、可靠性和验收文档。

边界：

- 工作目录仅 `kokoro-billing`，不修改 consumer 或 Root；
- 只有一个 canonical Schema，无 migration、`FOREIGN KEY`、`REFERENCES`；
- 不增加兼容 alias、双轨实现或 production Fake/InMemory；
- 复用 Root PostgreSQL/Redis，不启动重复容器。

检查：

```bash
git status --short
git diff --name-only main...HEAD
git diff --check
```

## 2. 行为验收

### Admission 与 execution receipt

- Authorize/capture/release/execution-event ingress 的裁决必须写 `entitlement_billing_command_receipt`，scope 至少为
  tenant + surface + command + `Idempotency-Key`；业务 identity 分别为 invocation、admission、admission 与 event ID。
- Digest 必须带 command version 并递归 canonicalize JSON。Capture/release 的完整 receipt 字段不能由 HTTP 解析后丢弃；execution
  必须把 contract 要求的 `Idempotency-Key` 传入 application 并持久化。
- 每个 command 在 admission/event 终态短路前先比较 durable receipt；同 key/identity payload drift 返回 409。
- Claim/effect/result 同 transaction；不使用无 fence 的 processing lease/reclaim。历史 `failed`、`unknown`、`processing` 分别返回
  stable `command_failed`、`command_unknown`、`command_unknown`。

### Checkout

- Existing `tenant_id + idempotency_key` checkout 必须在当前 offer/catalog 校验前读取、锁定并比较 versioned digest。
- Object key 的递归重排不改变 digest；array 顺序保留；非 JSON 值拒绝。
- 首次成功后禁用 offer，再以原 key/重排字段 payload 调用仍重放同一 checkout；payload drift 返回 409。
- 测试必须经过实际 Fastify route 与真实 PostgreSQL，Fake 只补充 transport mapping，不能替代该验收。

### Durable settlement

- `POST /v1/internal/payment/settlements/accept` 必须有 strict request body 和 `Idempotency-Key`。
- `payment.settlement.accept` 以 `settlement_id` 为 command identity。
- Receipt 保存 SHA-256 request digest 与精确成功 result；同 key 或同 identity 的等价重放返回同一结果。
- 同 key/identity 下 payload drift 返回 `billing.idempotency_conflict`；并发请求只形成一个 receipt/fact。
- Raw JSON 字段顺序不同不得被 Redis hint 误判为业务冲突。

### Durable expiry batch

- `POST /v1/internal/commands/expire-credit-holds` 必须显式提供 `batch_id`；`limit` 缺省规范化为 100。
- `entitlement.credit-holds.expire` 以 `batch_id` 为 command identity。
- Receipt 与 hold/allocation/account/outbox/result 同事务提交，result 保存精确 `expired_hold_ids`。
- 同 batch 换 key 重放原 result；同 key 换 batch/limit 返回冲突，不扫描或消费下一批 eligible hold。
- Worker 必须显式 tenant scope；daemon 每 tick 生成新 batch，一次性重试可复用固定 batch。

### Refund 与 result invariant

- Refund receipt 使用 `INSERT ... ON CONFLICT DO NOTHING` 后 tenant-scoped lock/compare/replay；provider + external reversal ref 是稳定
  业务 identity，digest 覆盖财务字段与可信 operator。
- 两个独立 PostgreSQL connection 的等价并发只形成一个 receipt/reversal 并返回同一 ID；唯一约束异常不得映射为 500。
- 任一 succeeded durable receipt 的 result 缺失或 shape 损坏必须成为内部 persistence invariant：外部 generic
  `billing.internal_error` 500，结构化日志保留内部 code，不得返回客户端 400。

### Redis loss

- Redis 永远只存 key-presence marker 或 best-effort lease；不能保存 request digest/result 或裁决 replay/conflict。
- API 与 expiry worker 在 Redis 初始连接/运行中丢失时继续 PostgreSQL path；PostgreSQL 健康时 `/readyz` 返回 200 且
  `data.dependencies.redis=degraded`。
- 同一 PostgreSQL database 在 Redis 缺失下关闭并重建 runtime 后，durable receipt/fact 仍可重放。

### Webhook

- Provider path 与 production registry 精确等于 `stripe|alipay|wechat`，其他值在处理前拒绝。
- Stripe/WeChat 使用 contract 声明的 raw-body headers。
- Alipay 只使用 form-urlencoded body 的 `sign` + `sign_type=RSA2`；query signature 不得通过。
- OpenAPI 不得包含 `mockSignature` 或把 Alipay body signature 声明成 query security scheme。

## 3. 静态与行为门禁

| Gate | 命令 | 通过标准 |
|---|---|---|
| ESLint | `pnpm lint` | exit 0，0 warning |
| TypeScript | `pnpm typecheck` | exit 0 |
| Vitest | `pnpm test` | exit 0，0 failed；记录 skipped 数量 |
| Build | `pnpm build` | exit 0 |
| SQL governance | `pnpm sql:check` | canonical Schema naming/time/no-FK gate 通过 |
| Contract | `pnpm contract:check` | OpenAPI、command shape/status、Redis readiness、webhook matrix、17 route parity 通过 |
| Combined | `pnpm verify` | repository-local gate 全部通过 |
| Diff | `git diff --check` | exit 0 |

`pnpm test` 未设置依赖 URL 时会 skip integration；skip 不能计为 PostgreSQL/Redis 验收。

## 4. 真实 PostgreSQL/Redis 验收

前置条件：

- 使用 Root 已有 PostgreSQL `127.0.0.1:55433`，为本轮创建 Billing 专用空 fixture database；
- 使用 Root 已有 Redis `127.0.0.1:56380/4`；
- 应用/测试从源码运行，不启动第二套数据库、Redis 或 Billing application container。

```bash
cd /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing
export DATABASE_URL=postgresql://kokoro:TOKEN@127.0.0.1:55433/DATABASE
export REDIS_URL=redis://127.0.0.1:56380/4
export REDIS_TEST_URL=redis://127.0.0.1:56380/4

pnpm db:apply-schema
pnpm test:integration
```

通过标准：

- Schema job 在 fresh database 成功，第二次安装因非空 guard 拒绝；
- integration 0 failed、0 skipped；
- `durable-command-receipts.test.ts` 覆盖 settlement replay/conflict/concurrency 与 expiry identity/replay/next-batch；
- `admission-command-receipts.test.ts` 覆盖 capture/release/execution 的 key/identity/digest/终态顺序；
- `checkout-http-replay.test.ts` 覆盖递归字段重排、offer disabled replay 与 drift 409；
- `payment-reversal.test.ts` 使用两个独立连接覆盖 refund 并发；`durable-result-http.test.ts` 覆盖损坏 result generic 500；
- `runtime-redis-loss.test.ts` 覆盖 Redis 缺失时的 runtime 启动/重启与 degraded readiness；
- Redis hint/lease suite 真实连接 DB 4；
- 所有 SQL 参数化且 tenant-scoped。

## 5. Root 十仓静态审计的 Billing 切片

Root verifier 没有 repository filter，因此只读取结果，不在本仓任务中修复其他仓：

```bash
cd /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro
python3 scripts/verify-ten-repository-standard.py --format json > /tmp/kokoro-ten-audit.json || true
python3 - <<'PY'
import json
from pathlib import Path

result = json.loads(Path('/tmp/kokoro-ten-audit.json').read_text())
violations = [
    item for item in result['violations']
    if item['repository'] == 'kokoro-billing'
]
if violations:
    for item in violations:
        print(f"{item['rule']}: {item['detail']}")
    raise SystemExit(1)
print('PASS kokoro-billing Root static-audit slice')
PY
```

## 6. Contract、Schema 与文档验收

- Contract、runtime 与 registry 的 provider 集合一致。
- Capture/release、settlement/expiry 的 request body 与 execution-event 409 和 runtime Zod/application DTO 一致；ready response 允许
  Redis `ok|degraded`。
- `contract/README.md` digest 等于当前 OpenAPI bytes。
- Schema 三张 receipt 表均有 nullable `command_identity` 和非空 partial unique index；nullable 只服务没有独立 identity 的其他命令。
- Required 文档集存在，CURRENT 明确区分实现、缺口和生产证据；API/DATA_MODEL/RELIABILITY/RUNBOOK 与当前行为一致。
- 不生成或手改 `src/generated/`。

## 7. TDD 与完成判定

TDD 证据至少包含：

1. capture/release/execution 只依赖 Redis/业务终态、未 claim durable receipt 时的失败测试；
2. checkout 字段重排被误判、disabled offer 阻断 replay 时的失败测试；
3. refund 独立连接并发泄漏 unique violation 时的失败测试；
4. succeeded receipt 损坏被映射为客户端 400 时的失败测试；
5. OpenAPI 缺 capture/release body、execution 409 或 ready degraded status 时的失败测试；
6. Redis 初始连接失败阻止 runtime/worker 时的失败测试；
7. 实现后的 targeted GREEN 与最终全量 GREEN。

只有以下条件同时满足才可报告本切片完成：

1. 分支是 `codex/billing-durable-command-webhook`；
2. 工作树干净，提交按 durable receipt、replay/concurrency invariant、Redis-loss/documentation 逻辑分组；
3. repository-local 全部门禁在最终内容上重跑；
4. Root Billing 静态切片 0 violation；
5. fresh Schema + real PostgreSQL/Redis integration 0 failed、0 skipped；
6. 最终报告列出 commit、命令结果、RED→GREEN 证据和剩余风险。
