# Database

PostgreSQL 16 only. 业务表按 `entitlement_*`、`payment_*` 前缀划分 owner；migration 使用 numbered SQL。

实现前遵循根文档：`docs/kokoro-handbook/technical/billing-sql-standard.md` 与
本仓 `database/migrations/0001-billing-core.sql` 是 PostgreSQL baseline；后续编号文件保留历史版本收敛记录。
