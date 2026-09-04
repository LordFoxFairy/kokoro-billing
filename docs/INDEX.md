# kokoro-billing 文档索引

本目录只描述当前 Billing owner 实现、协议策略、运行和缺口。字段级 API 事实源是
[`../contract/openapi/v1/openapi.yaml`](../contract/openapi/v1/openapi.yaml)，持久化事实源是
[`../database/schema.sql`](../database/schema.sql)；Markdown 不复制为第二份可编辑 Schema。

## 阅读顺序

1. [`CURRENT.md`](CURRENT.md)：当前实现、证据边界和待办缺口。
2. [`TECHNICAL_DESIGN.md`](TECHNICAL_DESIGN.md)：分层、bounded context、事务、状态机与运行单元。
3. [`API_CONTRACT.md`](API_CONTRACT.md)：visibility、认证、幂等、错误和分页策略。
4. [`DATA_MODEL.md`](DATA_MODEL.md)：35 张表的 owner、不变量、关系与 retention。
5. [`SECURITY.md`](SECURITY.md)：信任边界、身份、tenant、secret 与 abuse control。
6. [`RELIABILITY.md`](RELIABILITY.md)：timeout、retry、receipt、outbox、恢复与降级。
7. [`ACCEPTANCE.md`](ACCEPTANCE.md)：可执行验收矩阵和 Root 静态审计切片。
8. [`SLO.md`](SLO.md)：目标 SLI/SLO、错误预算、告警与当前测量缺口。
9. [`RUNBOOK.md`](RUNBOOK.md)：启动、诊断、止损、恢复和回滚。
10. [`ADR/`](ADR/)：本仓仍有效的架构决策。

## 补充说明

- [`BFF_INTEGRATION.md`](BFF_INTEGRATION.md)：BFF storefront owner-call 约束。
- [`RISKS.md`](RISKS.md)：短版风险索引；详细控制与缺口分别在 Security/Reliability。
- [`README.md`](README.md)：旧实现入口已收敛为本索引的辅助说明。
- [`../contract/README.md`](../contract/README.md)：contract owner、version、generation、breaking、provenance 与 consumer workflow。
- [`../database/README.md`](../database/README.md)：canonical Schema 安装语义。

## 权威顺序

当前代码、machine contract、canonical Schema 与上述 CURRENT/设计文档优先。Root 的
`docs/ARCHITECTURE_STANDARD.md` 是跨仓工程基线；Root handbook 中的 Billing 文章和历史 ADR 可用于背景与考古，
但不覆盖本仓当前 contract、Schema、代码或缺口清单。
