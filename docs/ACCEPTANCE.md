# kokoro-billing 验收矩阵

验收必须在待交付 commit 的干净工作树上重新执行。历史报告、旧 CI、Agent 自报、跳过的 integration test 和本地 fixture
都不等于当前结果或生产证据。

## 1. 范围门禁

本阶段允许修改：

- repository/docs/contract Markdown；
- `contract/openapi/v1/openapi.yaml` 的治理 metadata；
- `scripts/verify-openapi.ts` 的 contract 治理验证；
- `tsconfig.json` 的 `useUnknownInCatchVariables`；
- `test/architecture/` 的治理门禁。

不得修改业务 runtime、Schema、generated 或跨仓文件。检查：

```bash
git status --short
git diff --name-only main...HEAD
git diff --check
```

## 2. 静态与行为验收

| Gate | 命令 | 通过标准 |
|---|---|---|
| ESLint | `pnpm lint` | exit 0，0 warning |
| TypeScript | `pnpm typecheck` | exit 0 |
| Vitest | `pnpm test` | exit 0，0 failed；记录 skipped 数量 |
| Build | `pnpm build` | exit 0 |
| SQL governance | `pnpm sql:check` | canonical Schema naming/time/FK gate 通过 |
| Contract | `pnpm contract:check` | OpenAPI 3.0.3、关键边界、17 route parity 与精确 metadata 通过 |
| Combined local | `pnpm verify` | 上述 repository-local gate 全部通过 |

`pnpm test` 在未设置依赖 URL 时会 skip integration suites；这时只证明 unit/HTTP/architecture，不证明 PostgreSQL/Redis。

## 3. Root 十仓静态审计的 Billing 切片

Root verifier 当前没有 repository filter，先输出 JSON，再仅以 Billing violation 判定本仓：

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

其他仓的失败不归入本阶段结果，也不得在本仓分支修复。

## 4. 真实 PostgreSQL/Redis 验收

前置条件：

- Root 共享 PostgreSQL 可用；为 Billing 提供空的独立 database/schema；
- Root 共享 Redis 可用，URL 明确以 logical DB `/4` 结尾；
- 不新建第二套 repository-local PostgreSQL/Redis；
- fixture 只含测试数据，命令不得指向生产。

```bash
cd /Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/kokoro-billing
export DATABASE_URL=postgresql://USER:TOKEN@HOST:PORT/DATABASE
export REDIS_URL=redis://HOST:PORT/4
export REDIS_TEST_URL=redis://HOST:PORT/4

pnpm db:apply-schema
pnpm test:integration
```

通过标准：

- Schema job 在空库成功，第二次对非空库必须拒绝；
- integration 0 failed、0 skipped；
- PostgreSQL Schema、tenant lineage、checkout、settlement/reversal、credit/usage、receipt、outbox、reconciliation 测试通过；
- Redis hint/lease 测试实际执行且通过。

## 5. Contract 验收

- 每个 operation 精确声明 owner、visibility、stability、idempotency、permission。
- metadata 与 `src/interfaces/http/server.ts` 的现有 route allow-list 一致。
- contract route 集合与 Fastify route 集合一致。
- wire property 继续使用 snake_case，tenant header 继续是 `X-Kokoro-Tenant-Id`。
- execution event 没有未验证 `signature` 字段。
- `contract/README.md` 包含 owner、visibility、version、generation、breaking、provenance 与 consumer workflow。
- 本阶段不生成或手改 `src/generated/`。

## 6. 文档验收

必需文件：

```text
README.md
INDEX.md
docs/INDEX.md
docs/CURRENT.md
docs/TECHNICAL_DESIGN.md
docs/API_CONTRACT.md
docs/DATA_MODEL.md
docs/SECURITY.md
docs/RELIABILITY.md
docs/ACCEPTANCE.md
docs/SLO.md
docs/RUNBOOK.md
docs/ADR/*.md
contract/README.md
```

人工复核：

- CURRENT 明确区分已实现、目标、缺口与生产证据；
- API 文档不复制为第二份字段级契约；
- DATA_MODEL 覆盖 35 张表、UNIQUE 语义、无 FK 关系维护和 retention；
- SECURITY/RELIABILITY/RUNBOOK 的控制均能定位到源码或明确标为缺口；
- SLO 数值标为目标，不写成本地或生产实测。

## 7. 完成判定

只有以下条件同时满足才可报告本阶段完成：

1. 分支是 `codex/production-closure-docs`；
2. 工作树干净，逻辑小提交可审查；
3. repository-local 六项 gate 与 `pnpm verify` 使用最终内容重新执行；
4. Root Billing 静态切片为 0 violation；
5. 真实依赖若不可用，明确报告“未执行/未证明”，不把 skip 计为通过；
6. 最终报告列出 branch、commit、文件、命令结果和仍存缺口。
