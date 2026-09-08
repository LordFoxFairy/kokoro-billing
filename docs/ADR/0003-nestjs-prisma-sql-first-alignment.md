# ADR-0003：Billing NestJS / Prisma 与 SQL-first 收敛

- 状态：目标方案已确定；运行时未切换。完整 Prisma / 模块重写阶段门尚未通过。
- 日期：2026-09-08。
- Owner：Billing；任务与验收唯一入口：[`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md)。
- 基线：`7a193ba98f3e0554feb1cf7913919b8c36055e2c`。

## 事实与问题

当前是 Fastify 5、Zod 3、pg；35 张 SQL 表、17 个 HTTP operation。application 多为一行事务转发，实质编排与规则在
`infrastructure/postgres/repositories`；provider processor 直接依赖多个 context 的 pg 实现。旧 architecture test
禁止 `src/modules` 并强制 ports 文件存在，与当前 Root TS 手册冲突。不是安装 Prisma 依赖就能解决这些问题。

账务已有真实价值：durable receipt key/identity/digest/result、同事务 journal/outbox、退款累计金额串行、Redis 丢失不影响
账务 authority。任何替换都保留对应并发/回滚/重放断言；不删除 CHECK/唯一索引或放宽类型门换取 ORM 安装成功。

## 候选比较与裁决

| 方案 | 收益与成本 | 决定 |
|---|---|---|
| SQL-first + pg | 最大程度复用当前 PostgreSQL 锁、CHECK、partial index；仍需模块与类型收敛 | 当前态，不作为 Prisma 目标完成 |
| SQL-first + generated Prisma schema/Client | SQL 独占 DDL authority，Prisma 提供 typed CRUD；必要锁仍在同一 ORM transaction 内参数化执行 | **目标采用**；生成物只读指禁止手改，并非让 Prisma 只读、pg 继续写 |
| ORM-first Prisma schema + db push | 生成与建模路径简洁，但 7.x schema 无完整 CHECK 表达能力；另维护 SQL 补丁会引入第二可编辑数据事实源 | 不采用；不删账务 CHECK 迁就工具 |

框架目标 Nest feature modules，比较 `src/<feature>` 与 `src/modules/<feature>` 后选择后者：本仓有七个业务能力以及 config、
database、health、http、access、worker 等进程支持职责。只在切片需要时建文件，不预建空目录，不复制 System/IAM 源码。

## 数据访问与生成边界

1. `database/schema.sql` 保持唯一可编辑 canonical source；V1 无历史 migration 链。生成路径目标为
   `database/generated/schema.prisma` 与 `src/generated/prisma/`，两者由固定脚本生成，禁止手改。
2. 生成链：创建本轮独占临时 database → 安装 canonical SQL → introspect → 确定性名称映射/生成 → validate/generate →
   比较产物与 PostgreSQL catalog → 清理仅本轮资源。任何名称映射规则只表达生成命名，不另行描述字段/约束。
3. Prisma introspection 并非完整 Schema drift：CHECK、partial index predicate、默认值和精度等必须另以完整 catalog 比对验证。
   7.x partialIndexes 当前是 Preview；默认不启用，原 SQL 索引照常存在，生成验证必须显式记录支持边界。
4. 目标应用只保留一个 PrismaClient/adapter 生命周期；`pg` 可以是 adapter 底层依赖和安装/诊断脚本工具，生产业务中不再有
   独立 pg Pool/query 写入路径。禁止 pg 与 Prisma 分别提交同一用例、并行双写、runtime fallback。
5. 普通 CRUD 使用 typed Client。raw SQL 仅限具名 row lock/receipt claim、SKIP LOCKED outbox claim、经验证的原子计数或复杂
   查询；每项需任务板列出用途、owner、参数化、返回 schema 和测试。它们必须使用当前 Prisma transaction client；不提供
   让所有旧 SQL 原样穿过的万能 `execute()` 兼容层。后续原生 API 能完整表达且通过原测试后删除对应 raw 边界。
6. Service 决定用例事务；Repository 只维护具名数据访问。内部 database transaction scope 绑定当前 tx，跨模块公开能力不接收
   Prisma/pg 类型。嵌套用例先收敛成一个显式事务；不把 nested `$transaction` 当 savepoint。局部回滚确有需求时另列
   savepoint 白名单，测试内层失败/外层继续及外层全回滚。
7. bigint 在持久化边界显式映射；现有 safe integer 范围与 wire 十进制字符串保持受测，不全局修改 BigInt.prototype；canonical
   digest、durable result JSON 不直接 stringify bigint。原始 ORM/SQL 错误映射为稳定内部错误，不穿透 transport。
8. 锁、statement、idle transaction、连接及总调用预算分别配置；会话固定 UTC。P2034/SQLSTATE 冲突仅对完整可重放用例做
   有限指数退避+jitter，不盲重试提交结果未知或已发生 provider 副作用的事务。

## 业务与协议边界

- Payment、Subscription、Checkout、Refund、Credit、Metering、Reconciliation 保持 Billing 内部 owner 能力；Credit 拥有余额、
  grant、hold/allocation、journal、acquisition/fulfillment 写入规则。其他模块经 Credit 公开事务内能力调用，不 deep-import repository。
- Ledger 是 Credit 的 append-only 能力，不新建独立跨仓 owner。Receipt/outbox 是各所属用例的一致性结构，不另建业务模块。
- Payment worker 的事件分派是业务 Service 编排，不是数据库 Repository。API 和三个 worker 都使用受控生命周期，不能只迁 HTTP。
- Hosted checkout 独立切片：持久 claim/提交 → 事务外 provider 调用 → 条件 finalize；稳定 provider idempotency identity、
  unknown outcome、重启查询与 reconciliation 一起设计，不只把 await 移出函数。
- 当前 OpenAPI 继续 design-first；本轮不引入手写 code-first 契约副本。未来生成 validator 或全量 semantic parity 须由独立
  contract 切片证明。request ID header、envelope、ledger time 和错误语义变更先 owner contract，消费者随后固定 artifact 更新。

## 版本与来源（2026-09-08 实测）

`npm view prisma version dist-tags engines license --json` 返回 `latest=8.0.0-rc.13`、`prev=7.10.0`；latest 是预发布，排除。
`npm view @prisma/client version engines license --json` 返回 `7.10.0`。`prisma@7.10.0` / `@prisma/adapter-pg@7.10.0`
均存在，Prisma 包 Apache-2.0；Node 支持 `^20.19 || ^22.12 || >=24.0`。Nest core 当前稳定 `12.0.1`，MIT。
候选为 Node 24 LTS + Nest 12.0.1 + Prisma/client/adapter-pg 7.10.0；进入安装切片前复核所有 peer、实际 lock、license 与安全公告。
本轮**没有安装或声称验证目标栈兼容**；当前 Node 22.22.2、实际 pnpm 12.3.4 与 manifest pnpm 11.25.0 的差异留任务板处理。

官方资料（工具语义，不等于 Billing 兼容证据）：

- [Prisma v7 database features](https://www.prisma.io/docs/orm/v7/reference/database-features)：CHECK 的数据库执行和 schema 表达不是一回事。
- [Prisma v7 indexes](https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes)：partialIndexes Preview。
- [Prisma v7 transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)：交互事务、冲突与事务预算。
- [Prisma numeric types](https://www.prisma.io/docs/orm/v7/prisma-client/special-fields-and-types)：BigInt 序列化边界。
- [Nest modules](https://docs.nestjs.com/modules)、[Prisma recipe](https://docs.nestjs.com/recipes/prisma)：模块公开面、client 生命周期。

## 放行与退出条件

先交付安装保护/完整 drift，再做隔离 Prisma 承接验证；schema 35 表命名/主键/约束/writer 映射、全部事务组迁移和契约消费者边界
审查完成后，才放行生产 Prisma/模块重写。可以分小 commit 构建，但未闭合切换的中间 commit 不作发布候选；最后删除旧全局
四层、镜像 Service/port/factory、pg 业务查询和 Fastify 唯一入口，不保留兼容层。回退使用上一个已验 commit 与独立测试数据，
不在带真实账务数据的环境执行 V1 清库。

ADR-0001 的 Billing/PG authority/幂等语义继续有效；其中旧 ports 路径只描述基线。ADR-0002 的当前 contract authority 继续有效。
本 ADR 不宣称 fresh-schema 全量 drift、Prisma、Nest、provider sandbox、生产 SLO/DR 或完整跨仓切换已完成。
