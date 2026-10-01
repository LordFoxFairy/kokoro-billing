## R40 Root 验收：积分单位机器事实与引用位置门

本切片仅交付 experimental v2 2.0.1 的 source/validator，不激活 v2 HTTP、赠送、BFF/Web消费或支付。唯一 Credit 单位 metadata 为 1 Credit = 1,000,000 micros；不是现金兑换率、模型加价倍率或余额阈值。七 Credit 字段引用与原整数 wire 保持，现金/sequence、SQL/账务值不变；下方候选与70/71结果保留为历史，以本节为当前事实。

Root Node24.20.0 真复验：契约72passed/0failed/0skip；pnpm verify 595passed/383skipped/0failed（14.77s），format/lint/typecheck/build/sql/contract 全通过。日志 /tmp/kokoro-billing-unit-r40-root-72-full.log。Root 额外真实 YAML parse probe 拒含点 component 和共享 Credit alias 的额外位置，并接受合法现金 alias，/tmp/kokoro-billing-unit-r40-root-position-probes.log。独立冻结72审查 P0/P1/P2 均0；原71测试字节及四份原dirty正文逐字保留。383资源skip不算通过，v2运行与正式扣费旅程仍待验。Root统一提交此限定8文件 source/前缀；不接五份未交付设计正文。

## R40 YAML alias 位置语义返修，待 Root 独立验收

Root 继 R39 含点 key 真RED后，报告第二位置绕行真RED：YAML.stringify/parse 的合法 alias 可让额外 component 与已允许 Credit 字段共享同一 node，identity Set 因此放过不同出现位置；Root 应拒断言 exit1，日志 /tmp/kokoro-billing-unit-r40-root-alias-red.log。原 writer 本轮仅 append 一个用例：先把现金 amount_minor ref 共享到 ExtraCashAlias，经真实 YAML stringify/parse 核 node shared=true 且原 validator 接受；再把 Credit 字段 ref 共享到 ExtraCreditAlias，经同样解析核 node shared=true，要求 credit unit 专属拒绝。worker 本单例真实RED为1failed/71因筛选skipped，实际收到 []；没有修改原70/71文本或断言。

现唯一 visit 仅增加第三 callback 参数 readonly (string|number)[] segments，object key 保留为一个 string segment、array index 为 number segment，每次出现位置都遍历，即使共享 node。单位引用允许位置和 metadata 唯一位置比较 JSON.stringify(segmentArray)，不比较显示 path 或 node identity；含点/括号/转义字符 key 与结构层次不混淆。显示 path 和其他旧 callback/check 行保持，原检查剥单位段及版本并还原 visit 后逐字一致；无第二 walker、序列化/clone 规避 alias、合法 alias/key 禁令或第二单位配置。下方 R39 identity 实现和70/71结果仅保留作历史，当前实现以本段为准。

原21027 bytes/test SHA256 `5067ac12c3014a4b5d88cc998f81538cefc97ee97d8957308501fbb82d49cbac` 整段保持作 prefix，内含原20558 bytes/`252f289590f4ac3cb09649b6953eddd6b146a8b9619fcb94760b802d0e6d6c9f`。追加后 test SHA256 `b130e6f4628cba948140392a0838ab18f26736e693c436798a1bed8f34642e5d`；validator SHA256 `5237d3a42057c2828f943eff17f49e63e55b44508b19c0b8bd326c7194f51bb6`。source YAML f632ddec、README、v1、SQL/generated、其他 tests/IMPLEMENTATION_PLAN 及四份原 body 保持冻结；无 Git/共享基础设施写入。

Node24.20 worker 实际定点72passed/0failed/0skip（1.49s）；定点格式/ESLint/tsc exit0。完整 pnpm verify exit0：format/lint/typecheck/build/sql/contract 全通过，595passed/383skipped/0failed（978，13.91s，31files passed/42skipped），本会话工具日志 session30870。执行前清资源环境变量；离线Prisma generate为原脚本调用，383资源skip不算通过，既有 ECONNREFUSED 127.0.0.1:1 故障负例输出保留。最终冻结由 Root 独立 review/复验/提交，不把本 worker GREEN 或之前独立审当二次返修已放行，也不宣称真实资源、发布 artifact、v2 runtime、消费者或完整 Billing 完成。

## R39-P2 含点 component 名称碰撞返修，待 Root 独立验收

Root 独立审发现诊断字符串 path 被误用于允许位置判定：合法 component key `CatalogItem.properties.credit_micros` 与真实字段显示路径碰撞，可混入 CreditMicros 引用。本轮原 writer 仅 append 一项真实负例；同一用例先确认合法含点名称的普通 string schema 被接受，再将其换为 CreditMicros ref 并要求 credit unit 专属诊断。worker 实际单例 RED：1failed/70因筛选skipped、收到 []；随后仅现 validator 的 Credit 引用允许集合与 metadata 定义位置改用实际 JsonObject 节点身份，path 字符串仅作诊断，不禁止合法含点名称。原 metadata/ref/cash/auth/整数门与旧70项断言保持。

原冻结 test 的前20558 bytes SHA256 `252f289590f4ac3cb09649b6953eddd6b146a8b9619fcb94760b802d0e6d6c9f` 完整保留作 prefix；append 后 test SHA256 `5067ac12c3014a4b5d88cc998f81538cefc97ee97d8957308501fbb82d49cbac`，validator SHA256 `44e1a6a100ffa2e3daa33bada04955fd30f4eb3a214116e6019c10e39d9faf53`。YAML `f632ddec7b4a8528fcb325ef45f63bd2e37a05319f3505581a9515332cccf16e`、README、v1、SQL/generated、其他测试、IMPLEMENTATION_PLAN 与四份原 body 保持锁定；无 Git/共享服务/资源操作。

Node24.20 worker 定点71passed/0failed/0skip（1.42s），定点格式/ESLint/tsc exit0；完整 pnpm verify exit0：format/lint/typecheck/build/sql/contract 全通过，594passed/383skipped/0failed（977，13.99s；31files passed/42skipped），工具日志 session60716。清除资源环境变量；383资源skip不计真实通过，既有Redis故障负例 ECONNREFUSED 127.0.0.1:1 保留，离线Prisma generate为原脚本调用。此前70/593与完整文件冻结描述属于返修前历史；当前事实以本段71/594与追加前缀保护为准。Root 对最终冻结源独立 review、复验及提交仍待，不冒称 P2 已获独立放行、artifact/runtime/消费者/完整 Billing 完成。

## R39 Credit 单位 source/validator 候选已过 worker 离线门

基线 main `78aa2a3a88107ca1014893b10ae08150bb78ad7a`；Root R39真RED57failed/13passed/0skip与独立三面/测试0P0/P1/P2为放行前置。本轮 source 尚待 Root 独立复验/提交，不称已发布单位 artifact、v2 runtime、消费者或完整Billing完成。原五dirty设计body及C1已验代码/SQL完整保护。

contract/openapi/v2/openapi.yaml 候选 info.version=2.0.1/experimental、SHA256 `f632ddec7b4a8528fcb325ef45f63bd2e37a05319f3505581a9515332cccf16e`：CreditMicros 引用现 DecimalInteger，唯一 x-kokoro-credit-unit 定义version1/display_unit credit/micros_per_credit string "1000000"；NonNegativeCreditMicros 复用前者与现NonNegativeDecimal，七Credit字段绑定。除版本、两schema、七ref之外，完整解析对象逐项核与实施前相同；现金amount_minor、sequence、24operation/19path、auth/permission/原整数wire保持。无新response metadata/API/目录/生成器/依赖/SQL/额度/价格/低余额阈值。真实visit校metadata唯一位置/集合/类型/固定值、整数组合和所有单位ref允许位置/金额绑定；原validation剥本新增段与版本后逐字hash一致，未删旧安全门。

冻结 test SHA256 `252f289590f4ac3cb09649b6953eddd6b146a8b9619fcb94760b802d0e6d6c9f` 整字节保持。worker Node24.20实际 vitest定点70passed/0failed/0skip（1.36s），定点ESLint与tsc --noEmit exit0。完整 pnpm verify 首次仅format首门因最后一处validator格式退出1，修正该现文件后完整重跑exit0：format/lint/typecheck/build/sql/contract全部0；test为593passed/383skipped/0failed（976，13.98s，31files passed/42files skipped）。完整门按已有脚本调用离线Prisma generate（7.10.0）；没有refresh/数据库连接，生成字节保持。v1现runtime 17 route parity与v2目标24operation通过，不等于v2HTTP runtime已验。

执行前清除 DATABASE_URL/PRISMA_DATABASE_URL/SCHEMA_ADMIN_URL/REDIS_URL/REDIS_TEST_URL；383skip是未连接实际资源的既有PG/Redis等集成项（含冻结131），不计通过。纯套件已有Redis故障负例输出 ECONNREFUSED 127.0.0.1:1 保留；未连接共享Redis/PG/provider、启动开发服务或写Git。没有prisma:check/真实PG/消费者/正式provider/浏览器证据。Root继承冻结source/docs/test后重跑70/全门并独立审，按限定文件与prefix集成提交；BFF正式发布方向的固定owner commit/version/digest与单位生成、Web一次移除旧比例仍后继，原完整C1/C2/C3/M5、admin/IAM target、支付最后边界保持。

---

## R38 Root 已验 C1 终态来源切片

当前事实绑定本节所属 Git 提交；实施前 main 5c45f22419db43ae9a128543a056cd1c4a6ff013。仅 Credit capture/release source/replay、canonical CHECK/partial UNIQUE、正规生成及两定点测试，尚非完整 Billing 或正式用户扣费闭环。

Root Node24.20：两 integration 文件真实 PG 131passed/0failed/0skip（20.18s），日志 /tmp/kokoro-billing-terminal-r38-root-green.log。pnpm verify 的 format/lint/typecheck/build/sql/contract 全通过，完整测试 703passed/209skipped/0failed（44.01s），日志 /tmp/kokoro-billing-terminal-r38-root-verify.log；skip 未算真实通过。pnpm prisma:check exit0，日志 /tmp/kokoro-billing-terminal-r38-root-prisma-check.log；自有 reference 集合前后相同，未清共享数据。

独立冻结源审查 P0=0/P1=0/P2=0；repo SHA256 9247d3f813b2b38bc2cff6bdd0ca3a1490bdf04d6bbd068cc42f1f80a9a42588。此前完整门两项 production-prisma 失败通过删除越界 import/无效局部 catch 关闭，架构规则/原断言未放宽。

未闭环：跨 account 同 tenant/source 真实竞争与 HTTP 首因归一、expiry batch/grant 到期释放、单库 owner schema 应用组合、IAM 管理 target/正式赠送、C2/C3/v2唯一 runtime、provider/浏览器完整费用链；支付最后。保留未交接的原五设计工作区段，不把其候选当已发布。

## R32 Credit reserve 语义幂等局部修复已由 Root 复验

沿 C1 原实现，只将 reserve semantic digest 与传输 idempotency key 分离；key 继续写入首次 hold effect 和永久 receipt binding，schema/API/runtime 不变，无旧 digest fallback。冻结 source SHA256 4c1da7bfa4efb03562916c18fec86512888f62678c9c0c900236dcc2bd1b753c，test ec271ead541aea41924e166b26c29dcf8eb38c73553da0161bf8ef98f1d96fa5；独立 Sol 最终审查 0P0/0P1/0P2。

Root Node24.20 实际同一 PG 测试 RED 2 failed/22 passed/0skip → GREEN 24 passed/0skip（4.09s），覆盖同 identity 换 key、业务漂移、并发一效果双绑定、audit 写后失败回滚。新 command receipt PG 回归 5 passed；另两旧 DATABASE_URL 套件 23 skipped，不计真实通过。SCHEMA_ADMIN_URL fixture 临时库前后集合相同，cleanup_diff_exit=0，未清共享数据。日志 /tmp/kokoro-billing-reserve-r32-root-{red-r2,green,receipts}.log。

Root pnpm verify 实际退出0：format/lint/typecheck/build/sql/contract，全测试529 passed/280既有资源skip（13.56s）；当前 v1 route17 与 target v2 operation24门保持，不将其当 v2 runtime 已部署证据。五份原 dirty 设计内容完整保留，Git 只接本记录 prefix 与已验两文件。此片不是 capture/release/expiry/metering、正式赠送或整个 Billing/浏览器闭环；后续沿 C1/C2/C3/M5，支付最后。

# kokoro-billing 当前状态

## B8-M2b 持久一致性组件（2026-09-13，组件已验收）

- canonical 已从31表更新为32表：`billing_command_receipt`不再保存单值key，新增永久`billing_command_key_binding`；正式Prisma schema/provenance由canonical刷新。
- 新增事务内`CommandReceiptRepository`、`AuditAppender`与`OutboxRepository`。它们实现双域命令重放、可信scope审计、数据库时钟lease/fence、generation CAS requeue；当前仍未接入旧Fastify/pg业务writer或worker。
- Root 最终冻结树真实定向测试 **325 通过、0 失败、0 跳过**；receipt 11项、Outbox/audit 8项独立探针通过，Prisma/格式/lint/typecheck/build/SQL/contract 与源码/dist Nest数据库上下文通过。frozen install及生产/完整audit通过，独立最终审查通过；精确hash/日志/范围见唯一任务板。M3/M4之前不可部署，旧业务失败不通过恢复旧表或双writer掩盖。

## B8-M2b 生命周期与根查询（2026-09-13，组件验收）

- DatabaseModule/PrismaService 已实现 Nest 管理的单 Client/pool、并发初始化与幂等清理；TransactionService 接入生命周期 gate、只读 root client 与独立 worker 根事务入口。当前主进程仍旧 Fastify/pg，未接入新数据库组件。
- Root 冻结树真实定向测试 **239 通过、0 失败、0 跳过**；frozen install、生产/完整 audit、format/lint/typecheck/build/sql/contract 全通过。两个原缺陷探针与源码/dist NestFactory 数据库上下文 smoke 通过，独立审查通过。具体范围、命令和日志见唯一任务板 M2b 生命周期 R1。
- 生命周期切片已验收；永久key绑定与持久组件已按上节完成组件验收。旧业务失败保留至整体 writer 切换；不宣称整仓可部署或只需配置。

## B8-M1b v2目标机器契约（2026-09-13，目标契约已验收）

- 新增唯一目标机器源`contract/openapi/v2/openapi.yaml`：OpenAPI 3.1 / info.version 2.0.0，共24个experimental internal-owner operation；包含5类持久结果GET、拆分后的三条provider webhook及完整typed request/result/error/header/security。
- `contract:check`继续验证字节不变v1的17条真实Fastify route parity，并独立验证v2的ref闭合、operationId/治理、UUID与opaque身份、request-id、201/202 Location、caller authority禁用字段及三种provider ACK。
- 本切片不修改runtime、SQL/Prisma或消费者。v2通过仅证明目标artifact；M3整体切换后才删除v1校验分支并证明运行parity，当前仍不可部署。

Root冻结树format/lint/typecheck/build/contract通过；contract+architecture **204通过/0失败/0跳过**，独立8项变异、24operation、41组件结构与15实例通过。仅验证目标artifact，精确hash/日志/审查及未完成项见唯一任务板M1b。

## B8-M1 当前 canonical Schema（2026-09-13，离线模型已验收；禁止部署）

- `database/schema.sql` 已收敛为31张 `billing_*` 表、429列、31个单列 `id UUID` 主键、零外键；三类receipt、两类outbox及acquisition/fulfillment已分别合并为单一事实表，Prisma只读生成物由该SQL刷新。
- Checkout/Refund/Subscription/Execution恢复状态与约束已进入canonical；target-schema、Prisma、事务及Schema安装定向测试通过。此切片仅是未部署的模型中间态，不表示当前Fastify/pg业务writer已完成切换。
- 完整旧业务测试仍有依赖已删除旧表的预期失败；禁止恢复兼容表制造双canonical。生产writer、HTTP/消费者及共享Credit事务组由后续M3闭环。

Root冻结树实跑：format/lint/typecheck/build/sql/旧contract/Prisma一致性通过；7个本切片真实integration文件88项通过，独立约束探针32项通过；完整756项为621通过、135失败、0跳过，失败属于旧pg业务integration。精确hash、日志、命令、审查与未运行边界见唯一任务板B8-M1。

> 下方为按阶段保留的历史交付记录，其中“当前”“35表”“尚未切换Schema”等描述仅指各节标注的历史基线，不覆盖本页顶部M1事实；生产writer仍旧pg、目标Nest业务仍未交付。

## B8-S4 历史扣减链路切片（2026-09-12）

- 修复默认 UUID capture 的 22001，以及合法255字符 invocation 拼接内部key/source的长度溢出；删除短hold测试规避。内部事件随机UUID，内部关联使用 Billing admission UUID，外部调用身份/HTTP合同未收紧。
- 当前canonical增量为 usage_event.credit_hold_id VARCHAR(36) NULL UNIQUE，与当前hold类型一致；35表/369列/128约束/84索引。Prisma schema/provenance由canonical重新生成，不手改或另立schema源。
- 同hold/source重放、跨绑定拒绝、settle等待锁后重放及持久绑定校验已实现；故障注入比较整组账务快照，DDL/barrier用独占数据库。两位独立Sol最终只读审查范围内放行；Root最终全套752/集成235通过，均0失败0跳过，Schema/Prisma/源码与dist HTTP通过，精确命令与资源证据见任务板S4。
- 仍是当前Fastify/pg完整业务事务，不把局部修复冒称Nest/Prisma生产切换。M2a事务组件、31表模型、receipt/outbox合并、付款授权与Scheduler接线后续继续；外部provider sandbox尚未验收。


## 2026-09-12 最新交付：M2a Prisma事务组件

- 用户已确认首发无真实账务数据、尚未开放；历史数据/已发布major不再作为假设性阻塞，不授权清共享库。
- 新增src/database事务组件：Prisma callback + ALS、同client嵌套、rollback-only/首因保留、跨scope与关闭后误用拒绝、只读快照和有界预算。未接入当前Fastify/pg，不声称Nest/七模块生产切换完成。
- 独立双审闭环后Root最终实跑`pnpm verify`740通过、`pnpm test:integration`223通过，均0失败0跳过；catalog/Prisma无漂移、原源码/dist API smoke及独立编译事务组件真实PG smoke通过。精确冻结hash、命令、资源清理和TDD过程差异见唯一任务板M2a。
- Schema/OpenAPI/依赖/generated保持原字节；31表目标、receipt/outbox与完整业务writer仍待实施。Prisma跨仓使用原则已在Root TS手册§12.1/12.2，其他子仓引用手册，不跨仓导入本组件。
- Scheduler已有通用调度，但Billing当前认证与静态batch_id不匹配；接线未完成。IAM execution proof verifier仍是目标，不把有效资源scope或body payer当付款授权。未跑支付sandbox、Scheduler跨仓、Nest或镜像验收。


更新时间：2026-09-12。当前规范化分支为 `codex/billing-ts-prisma-alignment`；最终验收必须绑定交付时的 `HEAD`、
干净工作树和当次命令输出，不能继承历史报告。

本文中的“已实现”表示可在当前源码、Schema、contract 与测试中定位；不表示已获得生产流量、SLO、容量或灾难恢复证据。

## 当前规范化工作

- B8-R3目标三设计已进一步收敛：3receipt→1（固定namespace+surface和双唯一域）、2outbox→1（稳定事件身份、payment partial UNIQUE、lease fence和审计重启）；与R2履约合并合计目标31表，当前canonical仍35表。按次FeaturePrice为唯一销售profile，完整不可变价目表、明确生效排序、显式零价/缺价拒绝，历史授权验证digest；无生产调用token报价与quota占位的删除随完整实现/消费者major同切。未部署新表、Nest或业务Prisma。
- 连续实施次序已固定在任务板R3：R4可信付款人/执行身份及机器契约效果闭环→M1完整canonical/contract→M2一致性支持→M3/M4共享Credit全事务组及其余模块/worker→M5消费者和真实运行验收。用户已确认未上线且无真实账务数据；余下付款授权机器契约、消费者同切与订阅资格仍按独立业务门处理；这些不再被写成重复泛审计或单纯工具链升级。具体本轮审查/验证见任务板。

- B8-R2已把Prisma框架事务API及数据库最终幂等依据固化到Root TypeScript手册§12.1/12.2（Root提交4e17f7f3888f45352330f35514dccfad7e15e7fb），04事务补充只链接复用；Redis仅协调/缓存，不凭TTL决定重复账务是否可执行。
- B8-R2三设计/ADR已收敛首个核心模型决定：payment/subscription的acquisition与fulfillment合并为永久CreditFulfillment，精确引用grant/journal；当前单program profile按tenant/source唯一，换key同identity/digest重放、换授权参数冲突。保留account/grant/hold/allocation/journal、退款零delta永久结果与订阅T1/T2分工；删除旧35表一对一放行要求。当前canonical及生产仍未切换；receipt/outbox与销售定价后续由R3收敛；真实数据/major与订阅商业资格仍待后续门。审查及本轮静态验证见任务板B8-R2，不借历史712/205作新模型实现证据。

- B8-R按用户最新重点复审Billing本体SQL/model/结构：确认原“35表一对一迁移”不足以证明目标模型合理，暂作旧盘点，物理表数重新评估。保留account/grant/hold/allocation/journal各自事实；优先比较acquisition/fulfillment与三receipt/两outbox物理组织，明确单积分钱包/现金金额/计量单位及按次价格与token旧路径，删除反向分层而不只搬目录。两位只读审查与Root源码复核结论见任务板B8-R；尚未形成最终新ER/Schema，不冒称已重构或用S3测试覆盖该方案。

- B8-S3已修复对账四次autocommit混合快照false-ok：独立ALS/client、只读REPEATABLE READ、仅收紧2s语句/5s事务idle局部预算，原四查询/报告/可选tenant保持。连接FATAL不再触发未处理error退出；坏client销毁、嵌套失败关闭、原始错误及listener/release生命周期有真实子进程回归。数据Astra/TS Sol双审无阻断，Root冻结树全套712/集成205通过、0失败0跳过，Schema/Prisma/源码与dist smoke/audit通过，资源已清理；精确hash/命令见任务板。池等待/完整事务deadline、普通SQL错误被业务吞掉后的rollback-only仍待B8，未冒称通用事务完整性已闭环。

- B8-D3数据保护/对账内部方案已获数据Astra/TS Sol独立审查放行，完整ACL/CLI尚未实施，一致快照子集由S3承接。Root自建PG15项ACL反例证明只读事实的旧FOR UPDATE会被42501拒绝；真实reconciler双连接探针复现混合snapshot返回虚假ok，成为S3回归基线。目标采用完整事务锁承接后启用低权限、tenant必填有界CLI、owner只读页；详细证据/资源清理见任务板。

- B8-S2已修复READ COMMITTED下同tenant不同key价格发布revision竞争：tenant事务锁、独立MAX快照、1秒局部等待上限且保留更严格预算/立即恢复。双审无阻断，Root冻结树全套695/集成188通过，0失败0跳过，Schema/Prisma/源码与dist smoke/audit通过。RR冲突与整命令预算仍非本切片解决范围，精确证据见任务板。

- B8-S1已修复Outbox持久载荷解码绕过重试/死信：复用原fenced失败路径，输入类型保持unknown直到校验，双审首轮P2已闭环。Root最终冻结树实跑687全套/180集成零失败零跳过，Schema/Prisma/源码与dist smoke/audit通过；未改变双编码字符串对象的原解析语义。精确hash/命令/隔离清理见任务板；续租drain和未知业务效果恢复仍待D1。

- B8-G总门审计已汇总至唯一任务板：Nest依赖/模块与生产Prisma调用仍缺失，完整重写门尚未通过；B9a契约裁决必须前置B8，已纠正计划中的循环依赖。新增主动退款/复杂商品功能不自动扩入原Goal；现有退款/订阅正确性与工程收敛仍全部保留。
- 当前本地消费者为Web→BFF→Billing catalog/checkout：稳定purchase-intent key缺失、Billing201与BFF机器200不一致、Billing artifact未固定，均待owner新major后同切；未以本地负检索推断仓外无人调用。真实收费数据/仓外消费者及订阅发放policy已询问未决。
- 前一B8-G轮无DB `pnpm verify` 实跑format/lint/typecheck/build/SQL/17route及Prisma生成通过，507测试通过、158集成跳过、0失败；不是全套集成/新运行时验收，日志与基线见任务板。

- B8-D2d订阅身份/账单证据/两阶段Credit发放机制已获数据Astra/TS Sol R2局部放行，首轮2P2（未来周期状态、无webhook补查）闭环。商业资格已向用户询问，未按active/trialing默认当收款；12个本地真实解析签名场景由Root复验，生产metadata/周期/发放代码仍未修，三表与query变化仍是目标。

- B8-D2c退款内部设计已获数据Astra/TS Sol R2审查放行（首轮1P1/2P2闭环），并非实现放行：渠道观察与Credit效果分阶段、Refund.id去重、账户/付款精确关联、比例零delta和held保护。当前parser真实本地签名16场景复现非成功状态被归成功、累计金额/身份fallback及字符串金额放大；Root重跑通过。生产代码未修，详情见任务板；不是Stripe sandbox。

- B8-D2b已完成当前付款/退款HTTP终态核查，未修复链路：真实runtime/认证/PG及原支付worker CLI中，3入口首次和两种重放共9次202，只落付款/退款事实和成功receipt；3条Recorded事件两次worker均未领取。显式owner fulfillment作为fixture建立1000000 micros余额后，300+200 minor退款仍未扣回Credit。接口接受、provider退款完成与Credit效果不可混称，详细证据见任务板。
- 同轮机器契约核查：两个refund入口缺requestBody且202仍为泛型；现有17操作没有Checkout/付款/退款终态GET。allocation_mode当前只进入reason前缀，未执行分配算法。这些是待设计/实现缺口，不据此按金额猜授信规则或自动发起外部退款；v1/SQL/生产源码本轮保持原样。

- B8-D2a Checkout持久claim/事务外调用/fenced finalize、历史unknown、恢复预算与账户/会话维度已通过数据/TS独立设计审查；首轮1P1/2P2闭环。Root用合法配置的真实SDK+本地HTTP故障服务器复现总deadline后继续请求/迟到成功，精确证据见任务板；不是Stripe sandbox。Undici8.10.2仅传输候选，未安装；原持锁调用与背景请求仍待生产替换，完整API/Schema/数据演进未放行。

- B8-S0已实现Stripe一次性付款paid-only门：两种Checkout事件只有payment/paid且subscription缺省或NULL才允许发放。旧源码在独占PG真实回调链中复现unpaid提前创建settlement/account/grant/journal各1；修复后的完整665测试/158集成零失败零跳过，双审通过，精确冻结hash与Root命令见任务板。提交后仍须干净HEAD复验；不是Stripe sandbox或生产流量证据。
- Stripe完整接入仍有缺口：创建Subscription的metadata与本仓回调所需teamId/planId不匹配，现代item-level周期被解析为NULL；这些为本地适配器探针证据，尚未修复。Checkout事务外调用/未知结果恢复、API版本和provider sandbox仍待后续。用户已确认“staapi”为Stripe API，并强调国内支付/Billing本体复用成熟方案；当前Stripe用官方SDK，支付宝/微信主要是自写回调适配，历史Lago/Kill Bill/OpenMeter研究是模型参考而非实际部署引擎。具体事实与后续选型边界见任务板。

- B8-D1七模块DAG、共享writer、35表映射、usage-hold绑定、inbox fence与rollback-only事务已通过数据/TS独立设计审查；仅文档交付，不授权生产重写。B8-D2的major/消费者、202终态和Checkout恢复仍有未决项。

- B7d实现`0f0e7647d4531e94b2a1d7d8858e970850000c6e`：固定Prettier3.9.6，format:check为verify首门；142文件一遍、4文件两遍机械收敛，两个旧文本检查器补格式前后反例。双审及Root冻结树完整443全套/157集成、0失败0跳过，Schema/Prisma零漂移，源码/dist smoke与audit0；干净ce5b628再次完整443/157、0失败0跳过，见任务板。

- B7c已验收8fbf8e0：真实TS AST/resolver依赖门取代禁modules/强制ports，含80正反例和静态export来源追踪；双独立审查/Root冻结代码全验433全套、157集成、0跳过，catalog/Prisma无差异、源码/dist smoke和audit0。干净HEAD46dc851再次完整433/157、0跳过；精确命令/清理见任务板。
- B8原实证P1已分切片修复：outbox解码逃逸为S1；READ COMMITTED不同key pricing版本竞争为S2。其余worker恢复、完整事务与生产Nest/Prisma承接仍待D1/B8。
- UUID数据库切换涉及现有v1接受的非UUID资源ID，B9契约设计必须前置B8业务重写；线上数据/仓外消费者状态已询问，未据空GitHub发布记录作假设。

- B7b已验收，交付3fd97f56bee0c4aff8f0a095b9c9af164fc3e7fb；双独立审查及Root干净HEAD复验354全套/157integration、0跳过，Schema/Prisma无差异，源码/dist smoke通过，audit0：TS6.0.3、typescript-eslint8.69.0、ESLint10.10.0，全手写typed规则；原8.70候选因安装时发布冷却期失败而未采用，无豁免。见唯一任务板。
- **历史P0已由B8-S4修复**：默认UUID hold派生超长usage ID及短ID规避已删除，当前行为与本轮实测见顶部S4及任务板。

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
