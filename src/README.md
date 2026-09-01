# Runtime source layout

```text
modules/entitlement/  catalog、acquisition、fulfillment、terms
modules/credit/       account、grant、hold、allocation、journal
modules/metering/     usage event、price revision、authorize、settle
modules/payment/      checkout、provider event、settlement、refund/reversal
modules/metering/     usage、pricing、Billing admission、execution receipt
interfaces/http/      user、admin、internal、webhook
infrastructure/postgres/ pool、transaction context 与 repositories
infrastructure/redis/ fast-path、lease、异步协调
domain/               Payment/Admission 状态机与合法迁移
worker/                inbox/outbox、sweep、reconcile
```

当前只登记目标边界，不把空目录误报成已完成实现。
