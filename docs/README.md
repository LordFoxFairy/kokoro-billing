# kokoro-billing 实现文档

当前文档入口是 [`INDEX.md`](INDEX.md)。先读 [`CURRENT.md`](CURRENT.md) 区分已实现、目标与缺口，再按任务进入：

- API/consumer：[API_CONTRACT.md](API_CONTRACT.md) 与 [`../contract/README.md`](../contract/README.md)；
- 架构/事务：[TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md)；
- Schema/关系：[DATA_MODEL.md](DATA_MODEL.md)；
- 安全/可靠性：[SECURITY.md](SECURITY.md)、[RELIABILITY.md](RELIABILITY.md)；
- 验收/运行：[ACCEPTANCE.md](ACCEPTANCE.md)、[SLO.md](SLO.md)、[RUNBOOK.md](RUNBOOK.md)。

运行入口为 [`../src/main.ts`](../src/main.ts)，machine contract 为
[`../contract/openapi/v1/openapi.yaml`](../contract/openapi/v1/openapi.yaml)，canonical Schema 为
[`../database/schema.sql`](../database/schema.sql)。Root handbook 仅作背景，不覆盖这三份当前事实。
