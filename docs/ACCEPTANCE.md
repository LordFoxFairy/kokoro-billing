# kokoro-billing 验收矩阵

验收必须在待交付 commit 的干净工作树上重新执行。历史报告、旧 CI、Agent 自报、被 skip 的 integration 和本地 fixture
均不等于生产证据。

## 1. 本切片范围

允许修改：

- settlement/expiry application port、PostgreSQL repository、HTTP adapter 与 worker；
- `database/schema.sql` 中 command receipt identity；
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
| Contract | `pnpm contract:check` | OpenAPI、command shape、webhook matrix、17 route parity 通过 |
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
- Settlement/expiry 的 request body、response、400/409 与 runtime Zod/application DTO 一致。
- `contract/README.md` digest 等于当前 OpenAPI bytes。
- Schema 两张 receipt 表均有 nullable `command_identity` 和非空 partial unique index；nullable 只服务没有独立 identity 的其他命令。
- Required 文档集存在，CURRENT 明确区分实现、缺口和生产证据；API/DATA_MODEL/RELIABILITY/RUNBOOK 与当前行为一致。
- 不生成或手改 `src/generated/`。

## 7. TDD 与完成判定

TDD 证据至少包含：

1. settlement 无 durable replay 时的失败测试；
2. expiry 缺少 batch result/identity 时的失败测试；
3. OpenAPI 缺 request body/provider enum 时的失败测试；
4. Redis raw-body hint 对等价 payload 返回 409 的失败测试；
5. 实现后的 targeted GREEN 与最终全量 GREEN。

只有以下条件同时满足才可报告本切片完成：

1. 分支是 `codex/billing-durable-command-webhook`；
2. 工作树干净，提交按 durable command、webhook contract、authority regression、文档逻辑分组；
3. repository-local 全部门禁在最终内容上重跑；
4. Root Billing 静态切片 0 violation；
5. fresh Schema + real PostgreSQL/Redis integration 0 failed、0 skipped；
6. 最终报告列出 commit、命令结果、RED→GREEN 证据和剩余风险。
