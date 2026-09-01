# kokoro-billing 文档索引

当前仓库按 clean build 设计：不导入旧数据、不保留旧 API/表/兼容 writer。唯一目标架构是 [商业系统重构版最终架构](../../docs/kokoro-handbook/technical/50-billing-commerce-rearchitecture.md)，其实现级目标契约是 [目标 API 与 SQL 契约](../../docs/kokoro-handbook/technical/51-billing-target-api-and-sql-contract.md)；其余 Billing 文档为历史审阅记录或待清理的实现细则。

- [本仓 API Contract](API_CONTRACT.md)
- [本仓 Technical Design](TECHNICAL_DESIGN.md)
- [实现、BFF 接入与验收说明](README.md)

- [总体架构](../../docs/kokoro-handbook/technical/31-billing-subrepository-architecture.md)
- [成熟方案调研](../../docs/kokoro-handbook/technical/32-billing-mature-systems-research.md)
- [套餐、积分与卡密兑换码目标方案](../../docs/kokoro-handbook/technical/46-billing-package-credit-redeem-architecture.md)
- [Repository / Service / 设计模式总方案](../../docs/kokoro-handbook/technical/47-billing-repository-service-architecture.md)
- [需求闭环与验收标准](../../docs/kokoro-handbook/technical/48-billing-requirements-and-acceptance.md)
- [最终业务与技术架构](../../docs/kokoro-handbook/technical/49-billing-final-technical-architecture.md)
- [商业系统重构版最终架构](../../docs/kokoro-handbook/technical/50-billing-commerce-rearchitecture.md)
- [目标 API 与 SQL 契约](../../docs/kokoro-handbook/technical/51-billing-target-api-and-sql-contract.md)
- [ADR-023：模块化单体与 Redis 正确性边界](../../docs/kokoro-handbook/decisions/ADR-023-billing-modular-monolith-and-redis-correctness.md)
- [ADR-024：BillingSubject 与 PayerAccount 分离](../../docs/kokoro-handbook/decisions/ADR-024-billing-subject-payer-separation.md)
- [ADR-025：云厂商费用中心模式复用](../../docs/kokoro-handbook/decisions/ADR-025-cloud-billing-patterns.md)
- [ADR-026：商城 Order/Adjustment/PaymentCollection 事实层](../../docs/kokoro-handbook/decisions/ADR-026-commerce-order-payment-facts.md)
- [ADR-027：Billing API 版本与传输边界](../../docs/kokoro-handbook/decisions/ADR-027-billing-api-versioning-and-transport-boundary.md)
- [API 契约](../../docs/kokoro-handbook/technical/billing-api-contract-v1.md)
- [事务矩阵](../../docs/kokoro-handbook/technical/billing-transaction-matrix.md)
- [PostgreSQL Schema](../database/README.md)
- [SQL 规范](../../docs/kokoro-handbook/technical/billing-sql-standard.md)
- [迁移映射](../../docs/kokoro-handbook/technical/billing-migration-map.md)
- [Provider Event / Worker](../../docs/kokoro-handbook/technical/billing-event-processing.md)
- [CI 与迁移门禁](../../docs/kokoro-handbook/technical/billing-ci-and-migration-gates.md)
- Legacy 切流/旧 writer 文档不属于 clean-build 方案，不作为当前工作入口。
- [实现闭环证据](../../docs/kokoro-handbook/technical/billing-closure-evidence.md)
