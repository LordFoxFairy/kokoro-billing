## R59：本人读取 HTTP 数据边界（零DDL；R66机器候选已验）

R67 当前生成候选（2026-10-02）：按 Root docs/task.md 已审范围实施两个普通 scripts，官方 Hey API 0.99.0 的 TypeScript＋schemas(json) 两插件生成 index.ts/types.gen.ts/schemas.gen.ts，closed binding/provenance 输出 provenance.json；没有 SDK/client 或手改官方产物。43 原 schema/$ref/单位 metadata 语义、双次全字节一致与只读漂移门已实测通过；原206契约全文保持，仅EOF追加33项，完整29文件804pass/0fail/0skip，15.31s。format、两noEmit编译、contract:check 17+24、sql:check、frozen install 与 generated check 均exit0。本片尚未验收：官方 types.gen.ts:19 的 CreditMicros & NonNegativeDecimal 触发现有 typed-lint 重复交叉类型规则（exit1）；audit exit1，基线6high/5moderate，当前9high/5moderate，新增3high来自生成器固定 js-yaml4.2.0。未手改生成物、放宽门禁或升级既有依赖；Root 后续裁决与独立复验待进行。下列 R59/R66“未生成/工具冻结/Phase A”是前序阶段记录，不覆盖本段当前状态；HTTP/runtime、Nest adapter/Ajv、SQL/Prisma、赠送/计价/支付、其他owner与Git/资源边界仍保持，未发布或启动服务。

Billing main 156451051f6ee47ba9b128f481f96094bfb9f731已发布Credit本人read组件，历史真PG证据保持。当前工作树experimental2.0.2 source/checker候选已由Root R66在Node24实测29 files、771passed/0fail/0skip（含206契约，不重复累计）、format/lint/两noEmit编译门exit0，12.42s；Sol三机器反向字节审0P0/P1/P2，日志 /tmp/kokoro-billing-r66-root-machine-green.log。候选尚未提交发布、生成或注册正式HTTP，机器治理通过不等于运行认证通过。本Phase A仅README/四R59前缀；canonical database/schema.sql、Prisma/generated、查询、identityDigest、旧writer、第五IMPLEMENTATION_PLAN与历史正文不改。HTTP装配/完整C3未激活，不宣称单库组合或收费链通过。

### 唯一查询与零GET writer

Guard先取得受信semantic tenant+本人subject，Controller只调用已发布CreditService.getMyAccount/listMyLedger；同DatabaseModule client、mandatory CreditRepository、TransactionService.readOnlySnapshot。getMyAccount返回null由HTTP转404，disabled仍可读。列表用同tenant+subject找本人账户，再绑定cursor.account与真实journal boundary；完整高水位历史SUM和负累计/非法row/wrong-tenant child失败封闭不在HTTP重写。账户投影与ledger历史累计的语义不同，mapper不按当前余额修正行balance_after。

GET不ensure/refresh/cache，不创建account/receipt/key/audit/outbox，不更新generation/updated_at或修复损坏历史；无账户404，不是首次读自动赠送。高水位/末行范围、规范decimal→BigInt、固定identityDigest/2048限额沿已发布codec，Date/BIGINT仅在纯wire映射输出UTC Z/十进制string。UUID账户绑定不是授权；错tenant/subject cursor在事务前拒绝，错account/boundary不作他人查找。

### semantic身份与wire表示必须分开

SQL VARCHAR(191)/VARCHAR(255)与已发布codec身份按Unicode code point计数；非空、拒NUL/孤立surrogate，不UTF-16 .length、trim/NFC/剥BOM或缩ASCII域。Root R61已裁定ASCII header目标，完整算法以API_CONTRACT R59为唯一规范：所有身份 `u1.` + 无padding base64url(UTF-8)，tenant wire<=1022、subject<=1363，fatal/canonical decode后再核191/255语义。仅覆盖两本人GET；当前experimental2.0.2 machine/checker候选已Root771纯门/独立0审，专属参数/profile/auth-selection已记录；运行源码未改、新wire未发布/生成/HTTP，其他operation参数保持，不dual-read旧raw wire。

后继unit的tenant/subject两组leading U+FEFF合法正例按API R59明确参数化：U+FEFF是身份的有效首codepoint并计入191/255域，UTF-8首EF BB BF原字节必须保留，fatal解码+重编码逐字相等；默认剥BOM或误拒均应被正例捕获。不是新增数据库规则，不改identityDigest，不把BOM删去再查另一个主体；现bad UTF-8/canonical trailing bits/重复rawHeaders负例保持，实际tests/source仍未写。

decode结果才是JWT tenant绑定/BFF delegated context、查询参数与identityDigest输入；不把u1.字串写入tenant_id/subject_id、不把encoded长度误当身份长度，不hashencoded header，不创建身份映射表或cursor持久表。完整191/255四字节身份通过ASCII header传输的真HTTP往返须另验，组件191/255测试不替代header能力证明。身份header编码没有签名意义，BFF凭据或合法JWT验证独立成立，body/query不能选择本人。

### 后继只读生成边界（未实施）

后继正式生成方案与TECH/API当前段一致：只用官方TypeScript＋schemas（type:json）plugins，无SDK/client，产物index.ts/types.gen.ts/schemas.gen.ts及provenance.json。43个原component/$ref/单位metadata逐对象语义保持，sourcecomponent→official export closed registry/provenance由已批准两个ordinary scripts承接；Ajv2020 strict按 #/components/schemas/Name keys注册原对象，unknown/ref拒绝、no-coerce/default/remove。unitannotation仅metadata且owner checker/provenance锁，不新增业务schema/数据库事实。候选版本不等于已安装，安装前重新核验；当前未生成/HTTP。

### 事务、失败恢复与独立验证

后继真HTTP fixture只复用已有PostgreSQL，Root创建/清理本run owned canonical参照库；worker不启动共享服务或reset数据。实际GET前后比较account/grant/hold/allocation/journal/receipt/key/audit/outbox与generation/updated_at；无账户、disabled、空页、正常两页、foreign/非法cursor、坏query、损坏child/负累计、数据库故障及预算超时都覆盖。SQL观察必须证明401/403/query/foreignidentity预检零账务调用，成功读READ ONLY REPEATABLE READ，深层异常结束事务后可正常读取；不能用HTTP double或资源skip当集成。

HTTP Filter按CreditError/稳定数据库错误类型及SQLSTATE映射现machine400/404/500/503，不泄露row/SQL/token/message；完整因果错误保留在安全结构化日志，未知错误仍500，不假修复/重试GET写入。真实schema fresh/catalog/生成drift与既有111写读回归保持门禁，不重复设计余额或改SQL预算。

当前Prisma/installer仍public-only，正式单库owner schema组合由后继独立数据切片闭合，本HTTP D0不扩大其结论。无新表/索引/view/租户映射/Redisnamespace/事务/Pool，数据库role/部署不在本片。admin grant的权限/target映射/reason与实际额度、正式admission/执行证据/settlement/release皆独立门，不能从两个GET资格推导写入批准。完整C3唯一Nest main与旧writer删除条件见TECHNICAL_DESIGN R59，未承接的旧有效写职责不在此读片误删。

---

## R43-WIN06：Credit 本人读取与 ledger 分页数据设计门（零DDL）

### R52 当前 identityDigest 方案（零 DDL，资源复验待 Root）

canonical account/journal、查询、完整高水位历史SUM、readonly RR、实际boundary、tenant/account绑定及精确BigInt均不改。唯一编码变化为未发布v1 closed六字段version/scope/identityDigest/accountId/highWaterSequence/lastSequence，移除raw tenantId/subjectId，不留fallback/双读。内部语义cursor仍保留受信identity，digest不保存、不建表/索引/投影/secret，也不是认证token。

identityDigest = SHA-256：UTF-8 `kokoro.billing.credit-ledger.identity.v1`＋NUL字节作为domain，随后tenant uint32-BE UTF-8字节长度＋UTF-8字节，随后subject同格式长度＋字节；无填充base64url固定43字符，长度前缀按字节而非字符。受信tenant1..191、subject1..255个Unicode code point，拒NUL/孤立surrogate；encode/decode共同验证，decode重新计算与wire精确比较并在任何SQL前拒foreign。不改2048预算、UUID账户与0<=last<=high<=9223372036854775807、规范decimal/Base64/UTF-8/closed-key门。

Root R51实际21PG20pass1fail、R19合法191/255四字节身份容量失败，R18恢复已过。本轮codec74＋契约72纯测试146pass/0fail/0skip，format/lint/tsc两门exit0；integration仅collect21/0错误，无PG/Redis/provider或服务执行。R01–19/timeout正文保持，helper改为新合法wire使account/boundary/foreign负例继续到达对应门。真实最大身份两页与GET零事实写入由Root冻结复验，尚不宣称当前PG通过。以下R47/R43为历史阶段，游标当前方案以本节与下方更新后的格式段为准。

### R47 历史查询候选（零 DDL，真实 PG 待验）

新增具名 Repository 方法使用现 readOnlySnapshot client；先按受信 tenant+subject 找 canonical 钱包，不 ensure/refresh/write。cursor.account只与本人 id 比较，不作他人查询 selector。绑定后仅 EXISTS 探测同account wrong-tenant child与非法行，未选择异tenant payload；两个边界由限定 tenant/account 的真实 journal count核验。首次 max与续页固定highWater均留同只读RR事务内。

实际静态参数化 CTE：history到高水位计算完整 SUM(bigint) window，page外层再 seq<last/倒序/limit+1；history负累计 EXISTS 独立于page，LEFT JOIN sentinel让空续页也携带完整性结论，不静默丢弃损坏历史。sequence/delta/SUM以::text精确转BigInt；初页highWater+1用numeric比较容纳BIGINT上限，不把sequence或金额转Number。cursor规范非负decimal与BIGINT范围用BigInt判断，严格<=2048 raw/闭集/UTF-8/base64url，codec无数据库或签名配置。零 schema/table/index/view/投影/生成变化，不跨 owner，原写入路径保留。

Worker仅纯codec59passed及静态lint/typecheck/build exit0；这不证明SQL执行、RR/timeout、EXPLAIN或事实零写。Root20真实PG和原写矩阵待本候选冻结后复验；R46真实RED只是缺能力前置断言。integration全文SHA5c2c1f91锁、旧131断言锁，三构造机械补mandatory Repository。以下为 R43 D0 阶段记录，本阶段事实以本小节为准，五原dirty正文保持。

任务 R43-WIN06；Billing main 基线 `07fdd0746f99f718c042f0b7bee54e524d2f2a79`，Root 唯一任务表 `docs/task.md` 的 R43 行。当前只有本次四份文档前缀获授权，原五份 dirty 全文保持；source/test/contract/SQL/generated/dependency/runtime/Git/资源均不改。以下是当前设计候选，不是实现、HTTP 发布或测试通过声明。Root 三面文档门通过后才续授 tests RED，再单独授实现；赠送权限的人类裁决未回，本片不新增/推定 gift 授权。

### 唯一事实与查询owner

canonical仍 `database/schema.sql`（32表，SHA256 `5fbc61465f5af6dcac638ac0e887eb9ca7d29b1f41e60bc55d4f1196b39e755f`），正规生成schema/provenance/client保持字节，不新表、列、索引、view、migration、cursor/session或余额投影。账户唯一键 uq_billing_credit_account_subject(tenant_id,subject_id)，journal按既有 uq_billing_credit_journal_sequence(credit_account_id,journal_seq) 唯一排序。tenant写入边界仍Billing，本片不跨owner SQL/JOIN，不从旧entitlement_*读或union，不把代码表前缀误当已完成多owner schema部署。public-only事务/installer边界仍后继，未验应用单库组合。

账户只SELECT canonical billing_credit_account，WHERE tenant_id=trustedTenant AND subject_id=trustedSubject；GET不创建账户、不refresh windows、不写generation/updated_at、不缓存、不写receipt/audit/outbox。disabled行同样只读返回status。使用同一 READ ONLY REPEATABLE READ快照作账户绑定和账本页，复用TransactionService.runRoot(mode=readOnlySnapshot)的有限预算，不另连Pool、不FOR UPDATE；CreditService后继mandatory第四参显式注入现CreditRepository，由现credit.module.ts DI复用已注册实例；读取不绕Repository、不借Effects、不optional或自行new。Repository.requireActiveTransaction须核tenant与mode，不能复用要求write的现findAccount。旧credit-metering三处构造机械补参仅属GREEN，本tests阶段仍锁。仅getMyAccount单表也使用这个明确scope，不扩大readRoot允许raw的权限。

journal页只读当前找到的本人accountId，同时WHERE tenant_id与credit_account_id。No-FK下不按cursor提供的账户查，也不依赖UUID猜测代替tenant/subject绑定；所有grant/hold/journal写入与完整性维护沿现owner写用例。R18失败封闭必须先在同只读快照对已绑定本人accountId作child关系完整性探测：只检查同accountId关联journal是否存在tenant不一致（EXISTS或总引用数/本tenant引用数比较），不选取或返回异tenant内容，也不按他人accountId查。wrong-tenant child是CREDIT_READ_CORRUPT，不能仅WHERE tenant过滤后假装空页/正确累计。账户状态/金额与journal source_kind/source_ref等machine所需row非法、完整累计为负同样失败封闭，后继500稳定安全错误；不clamp/abs/fallback/GET修复。钱包available/held读取已提交投影；ledger balance_after为该账户全账本累计余额，包含尚held的posted credit，不等于当前available，也不把reserve/release重新造debit/zero journal。

### 排序、高水位与精确累计

采用单账户单调唯一journal_seq倒序；不是created_at分页，所以相同时间/时钟精度不会碰撞，不复制旧timestamp+sequence+id游标规则。第一页同一快照内确定 max(journal_seq) 高水位；空账本直接items空/nextCursor=null。所有页只看 seq<=highWater，续页追加 seq<lastSequence，ORDER BY journal_seq DESC、LIMIT limit+1；有more时对返回最后一行编码nextCursor，否则显式null。跨请求不持有数据库事务/服务端cursor；append-only历史和固定highWater稳定旧页，新第一页才看新journal。若将来允许retention/更改历史，需要owner另行breaking设计；当前不自动GC。

canonical journal没有balance_after列。本查询在本tenant/account完整历史（到高水位）上计算 `SUM(amount_micros) OVER (ORDER BY journal_seq ROWS UNBOUNDED PRECEDING)`，然后外层才过滤lastSequence/排序/limit，不能先裁page再SUM。只从账本事实推导每行balanceAfter，不用当前available/held倒算，不落新projection。SUM(bigint)在PostgreSQL为numeric，采用静态Prisma参数化$queryRaw SELECT（返回amount/sequence/sum的精确十进制文本，再转BigInt），不Number/浮点；source_ref/kind和UTC created_at从原行投影。SUM为负或行不满足machine约束是CREDIT_READ_CORRUPT ->后继500，不abs/clamp/fallback。不额外创建覆盖索引；先使用现account/sequence UNIQUE与绑定过滤，后继Root真PG EXPLAIN/预算结果不达标才独立评估，不在D0臆称性能达标。

### Cursor是有界不可信输入，不是授权

后继 codec 放现Credit目录单文件，只编码/严格解析。当前内部编码闭集v1格式：version=1，scope=credit.ledger，identityDigest、accountId、highWaterSequence、lastSequence；identityDigest按本页R52 domain与长度前缀重算，内部语义对象tenantId/subjectId来自受信context；highWaterSequence/lastSequence为规范非负十进制string，accountId为UUID，tenant最多191/subject最多255个Unicode code point，JSON UTF-8/base64url，原始cursor<=2048字符，不允许未知key/缺值/非对象/数组/坏编码。这是opaque query cursor的内部格式，不增加网络DTO或第二机器单位；不保存游标，不创建secret/signing配置，不把base64当加密/认证。

先语法/limit/tenant/subject校验，坏或foreign cursor拒绝且零SQL。然后只查询受信本人钱包：不存在404；cursor.accountId必须等于查得accountId，否则400且无他人lookup。0<=lastSequence<=highWaterSequence，两个boundary的journal行都必须属于同tenant/account且实际存在（相等允许）；不存在/超序为400，不按当前max自动纠正或fallback第一页。cursor不保证客户端未自行选择本账户合法分页起点，但任何输入只能缩到已授权账户且有界页，绝不因可改cursor获得他人权限。高水位/末行原字串规范性与范围以BigInt判断，无Number精度损失；codec读写与查询都不信cursor授予的数据范围。

### 影响与验证界限

内部账户/ledger投影使用bigint、Date；后继传输映射为现机器schema十进制string/UTC Z，必须精确保留9007199254740993与负delta，不保存display Credit/float，唯一单位metadata07fdd074保持。账户当前状态/seq/账本历史不被读取改变，时间只从库UTC事实转换。没账户为null/not_found；有账户没journal是正常空页，不伪造grant。读到错误/timeout时事务结束、零账务副作用；服务错误按API同名前缀映射现machine code，不新增wire状态。

后继Root-owned fixture用现 createPrismaDatabaseFixture 从 canonical SQL新建临时库，测试R01–R18：真实跨tenant/subject/账户cursor与高水位并发、完整window累计、DB READ ONLY、深层失败后零写入、BigInt精度；只有实际执行且0skip才是integration。原131写/终态和fresh/catalog/Prisma检查仍保留；本片未建测试、未运行资源、未seed/grant实际用户、未改现金/积分价格/额度/消费授权/到期。三面门通过不意味着唯一Nest runtime、gift、预占或正式扣费旅程已发布。

---

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

## R39 Credit 单位 source/validator GREEN 候选，未提交发布

基线 main `78aa2a3a88107ca1014893b10ae08150bb78ad7a`；Root 已实际冻结 RED 57failed/13passed/0skip，独立三面/测试审0P0/P1/P2。本轮只完成批准的单位机器源与离线 validator 候选：contract/openapi/v2/openapi.yaml info.version=2.0.1，SHA256 `f632ddec7b4a8528fcb325ef45f63bd2e37a05319f3505581a9515332cccf16e`；两 Credit schema、唯一 metadata 与七引用已落源，所有非单位 YAML 事实与原 wire/24 operation 保持。缺失/多份/错误location、metadata精确集合/类型/值、原整数组合/绑定用真实 visit 校验并返回单位专属诊断，原 validation 未删。

冻结 test SHA256 `252f289590f4ac3cb09649b6953eddd6b146a8b9619fcb94760b802d0e6d6c9f` 整字节保持；worker实际70passed/0failed/0skip，定点lint/typecheck0，完整门记录由同CURRENT本次前缀给出。Root 独立复验/提交尚待；candidate不是已发布artifact、不是v2 runtime或消费者GREEN。本片无SQL/生产/额度/价格/阈值变化，无新生成器/依赖/目录，原dirty正文完整保护。下列R38段保留批准设计和实施前事实；当前source状态以本段为准。

## R38 Credit 单位与持久数据：批准显示定义，零 DDL 变更

基线 main `78aa2a3a88107ca1014893b10ae08150bb78ad7a`。唯一 canonical 仍 database/schema.sql，32 表，SHA256 `5fbc61465f5af6dcac638ac0e887eb9ca7d29b1f41e60bc55d4f1196b39e755f`；本前缀之外原文逐字节保留。SQL/Prisma/account/grant/hold/allocation/journal/price/receipt 与所有持久 amount 不变，不回填/重算/转换历史事实，不运行数据迁移或调整额度。

Billing Credit 固定显示单位 1 Credit=1,000,000 micros，唯一机器定义后继落现 v2 YAML 的 CreditMicros.x-kokoro-credit-unit：definition_version=1、display_unit=credit、micros_per_credit="1000000"。CreditMicros allOf 引用现 DecimalInteger；NonNegativeCreditMicros allOf 引用 CreditMicros 与现 NonNegativeDecimal，仅前者持 metadata。info.version 目标2.0.1/experimental，当前source仍2.0.0、digest `eb95b6ddf4c3e611ff3eb065bcb39dad97d47cbf2203f8d6fd8105f17a5b42ad`，不是已发布单位 artifact。

七 wire 金额 CatalogItem.credit_micros、CreditAccount.available_micros/held_micros、LedgerEntry.delta_micros/balance_after_micros、Subscription.grant_micros、Admission.authorized_micros 使用专用 ref；除 delta signed 外均非负。复用现十进制整数约束，不改 bigint 存储或 JSON string 语义。现金 amount_minor 及 ledger sequence 的原通用整数 ref 保留；禁止给通用 schema 附积分尺度，禁止用现金币种/token/grant program 推算 Credit。六位显示精度派生自10^6，不持久化第二份比例、浮点 credit 或单位配置表。

比较契约 schema metadata（采用）与业务 response metadata（淘汰）：固定单位没有账户/tenant可变生命周期，不成为数据库事实或新 GET，不需要 cache/transaction/idempotency。单位发布与消费者 pin/provenance 从 owner committed YAML 单向派生，经 BFF 正式契约方向承接；Web 不读本仓数据/源码或直连服务。当前无单位生成链，本轮不改生成/依赖；后继验证确定性提取/--check 后才称 artifact 已发布，不把候选设计或 Prisma 生成当证据。

当前测试阶段仅现契约文件的真实 validator RED，覆盖单份 metadata、固定定义/类型、七 ref、现金/sequence隔离及合法控制；不写 YAML/validator/SQL/生成或运行 PG。Schema/catalog/131已验C1保持，不能证明单位或完整计费。后继不调整低余额阈值、现金价格/grant额度，不凭旧无真实数据记录宣称配置已迁移；金额/价格/grant数据审计及完整消费者切换仍由各 owner 与 Root 独立收口。

---

## R38 当前 C1：hold 唯一终态来源已落 canonical

唯一可编辑事实源为 database/schema.sql（32 表）；SHA256 5fbc61465f5af6dcac638ac0e887eb9ca7d29b1f41e60bc55d4f1196b39e755f。billing_credit_hold 新增 terminal_source_ref VARCHAR(255) NULL，无 magic default；active 时必须 NULL，captured/released/expired 时必须非空有界原始来源。

具名 CHECK 约束终态 source 与金额配对：active captured/released=0；captured 两金额和=requested；released/expired captured=0、released=requested。uq_billing_credit_hold_capture_source 为 tenant/source 的 captured-only partial UNIQUE；无新 FK/表/普通索引、journal_id、重复终态 JSON 或零 journal。Runtime 在固定资金锁序内校关系与完整性，重放不改 updated_at；数据库时钟决定首次转换瞬时点。

只读 database/generated/schema.prisma SHA256 5864752d64c08c5305eeb2824a2ccd50de90e9e8cc81b6a874bf7e6ca3e9d2dc，provenance SHA256 b2acd1fada9c6e0d762949672c76d63d0ad10f461a1a0234d9c1c23fd1ade8bb；Prisma/client/adapter 7.10.0，由 Root 自有 canonical reference 正规生成且重新生成比较通过。原 public-only installer 局限保持明确：本片临时库 fresh/catalog 成功不证明应用单库 owner schema 组合。旧数据不兼容，不自动迁移/修表/清理共享数据。

# kokoro-billing 数据模型

## B8-M3 七 owner Prisma writer 承接（2026-09-13）

实施前基线 `19195a13775123d666a586c90fc649116328880c`，canonical 当前为32表，SQL SHA256 `b8dd35be1137432742e3a250b3c95b406d5c993bd850f67ab720e21007cba521`。本阶段冻结 SQL 与正规生成 Prisma schema/provenance，不恢复任何旧表、view、alias、FK 或第二 schema。以下是实现映射与事务组补充，不维护第二份字段定义。

| 唯一 writer | 承接事实 | 原子组/跨 owner 方式 |
|---|---|---|
| Credit | account/grant/hold/allocation/journal/fulfillment/reversal/redeem | 普通 CRUD 用 typed Prisma；锁经当前 tx 具名参数化 raw，余额/分配/流水/永久结果同提交 |
| Metering | feature price revision/price、admission、usage event/settlement、execution inbox | 根用例 + Credit 事务内 effect，禁止本模块直接写 Credit model |
| Payment core | provider account/customer mapping、inbox、settlement | T1 记录可信事实；上层 PaymentEvents 用 owner API 编排，非核心反向依赖 |
| Checkout | offer/revision、checkout | 冻结报价与持久 attempt，提交后网络，回写校验 generation/身份；无网络长事务 |
| Refund | refund | 累计金额约束通过 Payment 锁定快照；Credit T2 冲正保存固定基数/结果，零 delta 的 journal=NULL |
| Subscription | subscription/period/term | T1 证据及资格观察与唯一任务，T2 通过 Credit 履约；晚证据/重复/同周期多 invoice 不二次发放 |
| Database 支持 | receipt/key binding、audit、outbox | 唯一具名组件写入，同业务 callback；无 Redis TTL 正确性依赖 |
| Reconciliation | 无新业务表 | 六 owner 同 readOnlySnapshot 读取，差异报告/具名重试，不直接修复余额 |

准入/usage–hold 绑定、支付履约、退款冲正、订阅周期发放、redeem/admin grant 各完整事务组必须覆盖尾部异常深层回滚。到期按一个可信 tenant/batch 原子处理 hold 后处理 grant，同一个 receipt 保存最终结果；加锁遵循 account→grant ID→hold/allocation 的全局顺序，不保留旧 grant-first 锁图。query/seed/worker 也遵守同一 writer，不以“脚本”绕过。

No-FK 完整性检查包括 tenant/account/subject、grant/journal/fulfillment、hold/usage、refund/settlement 与 provider account 绑定；唯一约束和条件更新兜底并发，不能先查询后无锁写。账户创建是显式写能力，不让 GET 隐式创建。永久 receipt/key 不清理；append-only 账本/审计保持既定 retention，Redis 丢失后重放仍只产生一份业务效果。

SQL/Prisma 未变不等于业务可用。M3 三设计门完成后允许七 owner writer 实施，最终 fresh/catalog/Prisma 一致性、真实 PG 并发/回滚、所有业务 test、HTTP 与 worker smoke 在 Root 冻结主树验收。此前 M1 135 项旧业务失败是待替换行为清单，删除旧源码同时承接有效断言而非 skip/remove 测试。订阅商业资格 policy 的未决与不激活边界见 TECHNICAL_DESIGN。


## B8-M2b 命令与key绑定正规化（2026-09-13，目标32表）

M1曾为31表；M2b现已落实32表canonical及生成物，Root真实fresh/catalog/Prisma验收见唯一任务板。为修复换key重放后该key仍可复用的已验证缺口，采用[技术方案M2b](TECHNICAL_DESIGN.md#b8-m2b-一致性组件与命令键绑定2026-09-13实施设计)：命令receipt拥有唯一业务identity/digest/永久结果，请求key绑定拥有唯一key→receipt事实，均由CommandReceiptRepository同一Prisma事务写入。

- 从`billing_command_receipt`删除`idempotency_key`及`uq_billing_command_receipt_key`；其UUID、tenant/namespace/surface/command、nullable业务identity、版本/digest/状态/result/时间和非空identity partial UNIQUE保留。
- 新增`billing_command_key_binding`：`id UUID`主键；`tenant_id VARCHAR(191)`、`command_namespace VARCHAR(16)`、`api_surface VARCHAR(32)`、`command_name VARCHAR(128)`、`idempotency_key VARCHAR(128)`、`command_receipt_id UUID`均非空；`created_at TIMESTAMPTZ(3)`非空默认当前UTC毫秒瞬时点。namespace general/payment/admission、surface internal的CHECK与命令相同；key非空；scope+key UNIQUE。
- key lookup以scope+key唯一索引执行，随后按receipt PK读取并验证同scope、identity与digest。非空identity仍仅在receipt上unique。没有外键，完整性由同事务writer/不变量与真实负例证明；没有无查询收益的receipt反向索引，没有JSON key数组或双存idempotency_key。
- binding不可修改/重新指向，生命周期跟随永久receipt；本切片不增加清理/历史迁移/可重用TTL，Redis丢失不改变绑定。成功identity重放的新key同事务持久绑定，参数冲突不绑定新key。
- 全部原账务表不改变职责/状态。canonical唯一SQL源与生成Prisma同步；对应catalog数量32、所有本地主键UUID、零FK；字段/约束/索引完整drift照常验证。本节32表已在M2b实际验证；下方M1的31表数字保留为历史切片证据，不冒充同一次验证。


## B8-M1b 首发目标契约切片（2026-09-13）

采用[API_CONTRACT的M1b决定](API_CONTRACT.md#b8-m1b-首发机器契约实施决定2026-09-13)统一覆盖历史major/调用身份/202未决表述：v2设计先行，M3删除v1及旧writer，不双部署；同步事实201/200与Execution202区分，结果查询依托既有Checkout/Settlement/Refund/Admission/Execution资源，不新增operation表。M1的31表canonical不变。IAM已发布本人消费授权经固定artifact消费，payer来自其可信user结果，不来自body。M1b仅完成机器契约/治理与验证，不放行运行时部署；完整writer、消费者和故障恢复门仍在唯一任务板。


## B8-M1 canonical 模型切片实施决定（2026-09-13）

用户已确认首发、无真实账务数据，Root按已审R2/R3进入M1离线Schema切片。此次是完整迁移中间态，不发布、不部署旧Fastify/pg到新Schema。运行API仍是当前v1机器源；目标资源/身份与R2/R3、IAM ADR006一致，真正HTTP/消费者变更随M1b/M3闭合，不把离线生成当作HTTP可用。禁止兼容表、alias/view/第二Schema、迁移旧数据或清共享库。

M1只落实DATA_MODEL既定35→31映射：所有资源PK为应用生成id UUID，同仓引用UUID，外部tenant/subject/provider/event/command身份仍opaque；Money整数最小单位+currency_code、Credit整数micros，TIMESTAMPTZ(3)。合并三receipt、两outbox、acquisition/fulfillment。
新增支持字段冻结：receipt(command_namespace general/payment/admission, api_surface internal, request_schema_version正整数, payload_digest 64位小写hex, result_schema_version正整数或NULL, result_json)，成功必须同时有两个result，非成功两列NULL；key/非空identity在tenant/namespace/surface/command域双唯一。outbox(event_namespace credit/payment,event_identity,payload_schema_version正整数,payload_digest,payload_json,requeue_generation非负,last_error_code,completed_at)，namespace+event_identity唯一，payment三元组partial唯一，lease成对、终态互斥且无lease。
fulfillment保存tenant/subject/credit_account_id UUID NOT NULL/source_kind/source_ref/program_key/authorized_micros/effective_at/expires_at/authorization_policy_version/authorization_digest/credit_grant_id/grant_journal_id/created_at/committed_at，source_kind限payment_settlement/subscription_period；tenant+source_kind+source_ref、grant、journal分别唯一。account非唯一，一账户可多次履约；同事务必须验证tenant/account/subject与grant/journal一致。不保留重复acquisition或无独立生命周期的status。refund reversal保留原fulfillment/grant与可空journal，零冲正有永久结果。
FeaturePrice采用完整revision快照：不可变published_at/effective_from/revision、feature_key、unit_price_micros>=0；同revision+feature唯一，删token费率/label分支/effective_to和quota占位。admission保存明确pricing_revision_id/feature_price_id/authorized_micros/pricing_snapshot_digest，quantity为一次调用1，不把CRD当币种。usage与hold仍保持同tenant一对一逻辑/唯一约束。
其他Checkout、Refund、Subscription、Execution的已批准持久状态字段按TECHNICAL_DESIGN D2a/c/d与DATA_MODEL落实；任何新增业务规则不由实现者猜测。M1新增DDL测试只证明target canonical，而非旧业务集成成功。完成目标门后继续整组writer，不以中间可生成替代全Goal。


> **B8-S4 局部实施门（2026-09-12，基线 ada75b2）**：当前扣减链路的 usage–hold 绑定先在现有唯一 writer 落地；
> canonical `entitlement_usage_event.credit_hold_id VARCHAR(36) NULL UNIQUE` 匹配当前 hold 类型，派生 event 使用独立 randomUUID。
> 同事务验证 scope/state、持久绑定及重放；HTTP 17 操作和内部方法签名不变，无新 API、FK、迁移或兼容分支。
> 当前 pg 整体事务保持，Prisma 全事务组承接仍待 M3；目标 `billing_usage_event.id/credit_hold_id UUID` 不等于当前类型已切换。
> 放置/唯一 writer/删除项/测试门详见唯一任务板 B8-S4；仅对该 P0 放行，不代替完整目标三设计门。
> S4-R2：内部 hold key/capture source/capture 与 release key 使用 Billing admission UUID；255 字符外部 invocation_id 原样保存，原 receipt 身份/digest 仍权威，不收紧 wire 上限或保留拼接 fallback。
> ensure 仅无锁校验快照和唯一绑定记录，消费权限由 settle 持锁后重验；旧全 Credit 锁图重排仍留整体事务组切换。

> **2026-09-12 当前首发裁决**：用户确认尚无真实账务数据、服务未开放；按首发clean-slate目标实施，历史数据/已发布major的待确认不再作为本轮前置。
> 不重置共享数据库、不构造历史兼容。M2a仅提前实现D1已审定且不依赖表/API的Prisma事务组件（见任务板），本仓SQL/HTTP/生产writer保持当前态；完整目标Schema与付款授权门仍按业务切片闭合。


B5 执行细节以 TECHNICAL_DESIGN 的全量 catalog drift 放置门为准：目标只读快照、显式 SCHEMA_ADMIN_URL、同实例 template0 自有参照库、全对象差异与有界清理；不改本文件后续 SQL 事实。

## 2026-09-08 数据规范化状态

唯一可编辑Schema继续是`database/schema.sql`。目标采用SQL-first + 只读生成Prisma schema/Client，见
[ADR-0003](ADR/0003-nestjs-prisma-sql-first-alignment.md)。B6a已引入只读生成schema/Client及隔离验证，未改表或业务数据；下面35表是当前态。

必须保留CHECK、业务UNIQUE、receipt identity partial predicates、UTC毫秒精度与BIGINT，不为ORM生成删约束。
Prisma生成模型不表达全部数据库语义，须以完整catalog drift验证；B5全量catalog gate已验收，Prisma生成不能替代它。B6a保留原生introspection自动生成的partialIndexes Preview元数据，
仅限ADR-0003窄例外，不运行db push/migrate；真实partial UNIQUE事务承接继续归B6b。

### 分阶段数据门

- **B4局部安装保护**：现有SQL不变，独占Billing空database，仅public目标；schema query参数缺省/public可用，其余配置在连接前拒绝。
  不存在的public或含任何非系统relation/type/function的database停止安装，不借search_path回落。advisory lock内检查后在同一事务
  执行DDL，固定UTC及超时；失败回滚并释放资源。只读检查既有用户对象，不修改/清理它们。设计细节见TECHNICAL_DESIGN。
- **B5完整drift**：覆盖35表的列/type/precision/null/default、PK/UNIQUE/CHECK/index definition/predicate以及无FK；正反例必须
  证明缺约束/错predicate被识别。比对expected来自canonical SQL安装的隔离参照库，不手写第二份完整Schema。
- **B6 Prisma承接**（详见TECHNICAL_DESIGN B6门；generated schema保留SQL命名identity映射，SQL不变）：生成链、全部模型、typed CRUD、同一tx锁/receipt/outbox、错误映射与BigInt受测后才进入生产替换。
- **B8数据规范切换**：当前`payment_*`/`entitlement_*`、业务名VARCHAR主键、`currency`与Root默认命名有差异；逐表列出
  owner前缀、`id UUID`、`currency_code`映射及索引/约束/writer影响。tenant/subject属于既有opaque契约，不机械改UUID。
  先完成映射与契约验证，随后整个闭合事务组一次替换SQL、Prisma生成、查询、seed、测试；当前名字不冒充目标名字。

Credit/Ledger当前被多个pg类写入；目标由Credit公开事务内能力统一写account/grant/hold/allocation/journal/fulfillment，
Payment/Refund/Metering/Subscription仅编排调用。具体模块表见TECHNICAL_DESIGN；无外键orphan覆盖、retention、append-only
权限和reconciliation运行入口仍是未交付项，不用文档代替安全保障。B4局部门已明确且无Schema/API变更；完整业务/Prisma门仍待验。

Canonical source：[`../database/schema.sql`](../database/schema.sql)。本文说明 owner、关系和不变量；列类型、nullable、
default、CHECK 与索引的最终事实仍以 Schema 为准。

## B8-R3 一致性存储与定价模型（2026-09-12目标，未应用DDL）

本节与R2共同更新D1，现有35张canonical表仍未改变。由生命周期与真实用例推导：履约两表合一、receipt三表合一、
出站投递两表合一，目标物理表数暂为31；不是以31为指标删事实。后文迁移盘点已更新，完整字段/约束仍待唯一canonical切片。

### 单一持久命令记录

采用`billing_command_receipt`统一三张同生命周期的receipt，不合入outbox或账本。比较继续分表（多份同构查询，无不同生命周期证据）
与显式scope统一表（采用）；业务命令owner仍在各feature，支持层不拥有发放/退款规则。

- 新增非空`command_namespace`，闭合集为general/payment/admission，逐一对应旧三表；非空`api_surface`当前固定internal。
  这两列由注册命令决定，不从body读取，不随模块移动改名；未来协议域增加须明确去重与切换语义。
- 唯一键为(tenant, namespace, surface, command_name, idempotency_key)；非空command_identity在相同前缀下建立partial UNIQUE。
  identity仅对确无独立业务身份的命令允许NULL；settlement/refund/admission/execution/expiry等命令在入库前强制其业务identity。
- 保留应用UUID id、versioned request digest、created_at/updated_at，以及processing/succeeded/failed/unknown语义。
  本地成功路径在一个Prisma事务中claim→effect→result；新processing不独立提交，正常失败全部回滚。历史failed/unknown/孤立processing
  不获得自动重做许可；外部操作等待状态属于Checkout等业务对象，不拿receipt充当长时队列。
- succeeded要求非空且符合该命令result schema的永久结果；SQL检查非NULL，运行时按版本解码，损坏报不变量事故。
  identity/scope/digest/成功result不可改。迁移只补scope及必要ID映射，不重算历史digest，不丢弃成功result或更换command版本绕过去重。
- 同时解析key与identity两个唯一域；分别命中不同记录时冲突，不能任选其一。恰好命中同一成功记录且identity/digest一致才重放，
  换key不重复执行；参数漂移冲突。并发约束失败后整组回滚，禁止在aborted tx里继续查询，按既定重试预算重查已提交结果。

### 单一出站投递表

采用`billing_outbox`，新增受控namespace=credit/payment；credit只是原entitlement队列的历史协议域，**不是Credit业务owner**，
Metering等事件仍由其业务owner决定。一份存储/租约实现，不新建消息总线、CDC进程或额外第八业务模块。

- id UUID、tenant、namespace、aggregate_type/id、event_type、稳定event_identity、payload_schema_version、payload_digest及payload_json
  为不可变投递身份/载荷。事件身份取版本化event_type与永久业务结果/任务ID（必要tenant），不取随机投递ID、attempt、lease或payload hash。
- UNIQUE(namespace,event_identity)防同一事件重复入队；payment另保留原aggregate_type/id/event_type的partial UNIQUE，predicate为namespace=payment。
  credit不机械套payment三元组唯一键；若未来同aggregate同type有多次合法occurrence，每次必须有不同稳定结果身份。
  同identity载荷/版本/aggregate漂移是冲突，不以ON CONFLICT更新payload解决。
- 沿用lease_token/until、attempts、next_attempt_at、dead_lettered_at与受控last_error_code，原published_at目标改为completed_at。
  completed只表示已注册handler确认本次投递完成，不表示外部支付成功，也不代表其他owner业务状态。状态由这些列推导，不再存重复status。
  CHECK要求attempts非负、lease成对、完成/死信互斥、终态无lease；payload版本为正且digest符合固定格式。
- claim以短Prisma事务和SKIP LOCKED选未完成/未死信且到期、lease空或已过期的行，并原子写入新token/lease及attempt。
  renew/complete/retry/dead-letter均比较tenant+namespace+id+token+未终态+尚有效lease；失租者不得覆盖新worker，handler结果仍靠owner幂等。
- 有界指数退避+jitter，解码失败也计入attempt；unknown handler/未注册事件不被空ack。人工重启只允许具名授权/审计命令，
  以`requeue_generation`（非负）和所观察死信状态CAS，同row同event_identity、同payload；generation递增，attempts作为本次重启周期计数归零，
  原generation/attempt/error进入同事务audit，不擦除历史。缺少旧outbox行时须从永久源事实恢复同一已注册载荷，不编造新身份。
- pending/lease/dead-letter迁移保留恢复依据；退役版本按TECHNICAL_DESIGN R3显式处置，不空ack或原位改义；暂不启用TTL删除。完成行/事件去重事实的清理须另有覆盖全部重放窗口的方案，
  不随Redis TTL删除。迁移检测历史重复/跨scope碰撞，遇不一致需受审处理，不自动选一条覆盖。

持久业务结果与投递分离：handler成功后ack丢失可重复调用，但内部handler先重放owner永久结果；外部投递只对已批准receiver承诺至少一次，
使用稳定event identity及接收方去重，不声称数据库outbox带来跨服务exactly-once。事件去向/删除清单见TECHNICAL_DESIGN R3。

### 单一按次销售价格，不保留幽灵token计费路径

依据当前admission确实用reservation_micros作为按次最终价格、token quote无生产调用的源码调查，选择当前profile为feature按次收取Credit。
这也与Root旧商业文档50 §7.5的按次方向一致，但不采用其中过期工程规范、部署结论或所有额外商业能力。
比较：保留两个混用费率路径（淘汰）、建立通用多profile引擎（当前无消费者，淘汰）、具名FeaturePrice单一销售事实（采用）。

- `billing_feature_price_revision`保存tenant内发布序列、effective_from、published_at及创建/审计引用；一次发布是一份完整且非空价目表快照，
  不是增量补丁。发布序列由同tenant事务串行分配+UNIQUE兜底；不同key并发发布仍各得不同revision，不用“冲突就当成功”。
  revision.published_at非空即不可变发布事实；revision及完整feature price集合、receipt/result、必要audit在一个Prisma事务提交。
  不先提交published revision再逐行补价；任一行校验/插入失败全部回滚，外部读者只见完整旧快照或完整新快照。
- `billing_feature_price`保存UUID id、tenant/revision引用、feature_key及unit_price_micros BIGINT>=0；UNIQUE(revision_id,feature_key)，
  同事务核tenant归属。零价必须显式发布，含义为included；缺price拒绝，绝不默认免费。
- 发布事实与feature price不可变，不保留active/disabled可变价格状态、label/model定价维度、input/output/cached费率及reservation字段。
  effective_to不再维护；在一次数据库时刻t，先选择已发布且effective_from<=t的最大(effective_from,revision)快照，再只在该快照找feature。
  revision是发布序列而非时间优先级；同生效时刻高revision胜，未来快照尚未到点不可见。缺feature不回落旧revision，避免混合价目表。
  调价/撤下单feature通过新的完整快照表达，不原位改已授权价格；本profile不另造撤销后隐式回落的API。
- Admission固定pricing_revision_id、feature_price_id、授权micros及pricing_snapshot_digest，指向不可变feature price/revision；按次quantity=1，
  authorized amount即该unit price，无token取整。快照digest含版本、tenant/feature、revision/feature price、单位及精确价格，不含当前时钟或后续状态。
  admission.created_at明确作为定价时刻，使用该事务的数据库瞬时点；selector与写入使用同一时刻，不受应用机器时钟影响。
  digest由Billing按版本生成，不接受caller digest；读取历史定价依据时按持久tenant/feature、revision ID/序号/effective_from、price ID、
  Credit单位及unit price重算，并核授权amount等于price、引用同tenant/feature，缺行或不一致报不变量错误，不回落现价。
  Capture只使用通过上述校验的原授权金额/引用，不重新查当前价格；hold/usage记录与admission绑定保持同tenant与同一价格依据。
  已成功命令仍按receipt的identity/digest/result先重放，不因当前price发布或时钟推进而重新执行账务。
- TS价格和Credit数量使用bigint及具名业务语义，wire使用十进制字符串；不经Number舍入。用于账务对账的按次数量记录1而非伪造token=0。
  Usage的model/label/meter_kind等执行归因可保留，但不是销售price key；provider成本未来若有真实需求单独明确owner与货币单位，当前不造成本表。
- 删除无人调用的UsagePricing.quote/listActive/quoteForHold、token费率/缓存token占位及对应旧factory/ports/测试；保留真实admission、
  hold/capture/release与用量归因。规则测试迁为FeaturePrice完整快照/并发/时间边界/历史授权回放，不通过删除风险断言换绿。
- account.quota_micros/quota_period没有配置、消费窗口或准入writer；目标从account/summary移除，并在major消费者切片同步Web schema/UI/fixture。
  这不删除grant赠送/订阅发放能力，不宣称当前存在完整周期quota。不把可用余额改名为quota，也不在本轮新增QuotaPolicy/Window服务。

本地消费者证据只覆盖当前检索到的代码，不能证明仓外无人调用。旧token/配额字段及当前stable v1在正式切换前保持原样；API影响见API_CONTRACT R3。

## B8-R2 核心模型裁决（目标设计，尚未应用 Schema）

本节基于当前实际writer与B8-R复审更新D1目标，而非保持旧表数的改名工程。采用业务模型驱动的模块化Billing；
不部署第二账本，也不在本轮增加税务、发票引擎或现金复式总账。以下是关系与不变量设计，不是第二份可执行Schema。

### 保留的核心事实与逻辑关系

| 事实 | 唯一职责 / writer | 不合并的原因 |
|---|---|---|
| CreditAccount | Credit：单tenant/subject积分钱包的余额投影及串行写入锚点 | 快速查询与并发控制，不代替批次和历史流水 |
| CreditGrant | Credit：来源批次、原始/剩余量、有效期和消耗顺序 | 随消费/到期变化，不能替代永久发放依据 |
| CreditHold | Credit：一次预留的状态与数量 | 预留不等于实际扣减 |
| CreditHoldAllocation | Credit：hold占用哪些grant，以及各批次确认/释放量 | 解释消费来源，避免只记一个总余额而丢失追溯 |
| CreditJournal | Credit：不可变增减事实及账户序列 | 重建与核账依据，不是可覆盖的余额字段 |
| CreditFulfillment | Credit：一次已成功发放的永久授权及结果 | 合并旧acquisition/fulfillment，仍独立于可消耗grant |

逻辑关系（由同tenant校验/唯一约束/同事务维护，不创建数据库FK）：

```text
Payment settlement / Subscription period（已冻结授权） -> CreditFulfillment
CreditFulfillment -> 精确CreditGrant + 正额grant journal
CreditHold -> CreditHoldAllocation -> CreditGrant -> CreditAccount
CreditJournal -> CreditAccount；Usage settlement -> CreditHold + Usage event
Refund -> CreditFulfillmentReversal -> 精确原fulfillment/grant及可空冲正journal
```

Money = 最小货币单位整数 + currency_code；CreditAmount = 整数micros；UsageQuantity另有计量单位。
默认一个subject一份可互换积分钱包，program是来源/政策而非余额分区；不把CRD当真实现金币种，不引入无需求的多钱包。
按次销售profile已由R3收敛，token成本不混入销售价；旧定价路径/quota字段的实际删除随实现与消费者同切。

### acquisition + fulfillment：合并为永久成功事实

比较：①继续两表（不采用，当前两个writer都同事务创建并立即committed，未见独立授权受理生命周期）；
②合并为CreditFulfillment（采用）；③直接并入grant（不采用，会把永久授权/结果与可消耗余额生命周期绑死）。
当前证据为payment/billing-settlement-service.ts:292–330与credit/subscription-grant-service.ts:53–91，位于本仓
src/infrastructure/postgres/repositories，基线fff756c；Schema当前仍保留两表。

目标`billing_credit_fulfillment`承接以下字段语义：

- 应用生成`id UUID`，对外/内部业务结果继续称fulfillmentId；tenant/subject为opaque，account/grant/grant_journal为同仓UUID引用。
- source_kind限定本profile的payment_settlement/subscription_period，source_ref为已验证的settlement/period身份；
  program_key、authorized_micros（正整数BIGINT）、effective_at/可空expires_at、
  authorization_policy_version及authorization_digest保存不可变授权；有效期非空时expires_at须晚于effective_at。
- grant_id、grant_journal_id非空且分别唯一；created_at/committed_at非空UTC毫秒瞬时点。只在发放成功事务中INSERT，
  不设置pending/failed/reversed状态：等待属于来源用例，冲正属于独立reversal事实；原成功事实不随退款改写。
- 当前一次性付款/单item订阅profile限定每个`(tenant_id, source_kind, source_ref)`只有一次发放、一个program、一份grant，
  此组合建立UNIQUE，**不把program放进可重复发放的唯一键**。同source换program/subject/account/额度/窗口/政策为冲突。
  该边界与现有journal的tenant/source/kind唯一性及D2c单grant退款一致，不为未请求的多program发行扩展账务profile。
- 先查并校验永久成功结果，再检查首次发放资格；重放不因当前报价下架、订阅取消、周期过期或grant耗尽而再发放/失败。
  digest按版本化规范化授权计算，不含投递Event ID、observed_at、当前时钟或可变provider DTO。
- 在同一个Prisma事务中验证来源授权及同tenant/account/subject，创建fulfillment、grant、正额grant journal、更新account及必要outbox/result。
  验证grant原始量/有效期与授权一致，journal的account/source/kind/amount与发放一致；UUID可预生成，不靠写入顺序替代完整性检查。
  重放直接使用永久grant/journal引用，删除旧多态source JOIN + LIMIT 1的模糊选取。

本轮只收敛已有payment/subscription履约profile；admin grant/redeem不被无证据地强制新增一套履约流程。
Subscription T1把waiting/资格/固定授权保存在period/term及outbox，不建pending CreditFulfillment；T2才与Credit全组原子提交。
退款仍按精确原fulfillment/grant和G/S快照计算，独立保存每笔CreditFulfillmentReversal；零delta也有永久成功结果、无journal。
删除acquisition表/模型/引用、重写refund/reconciliation查询、生成Prisma与对应测试必须同一闭合实施切片完成；
历史ID/数据/仓外引用处理仍受major与数据演进门约束，不据此次模型裁决直接清库。

三receipt/两outbox的物理组织由R3裁决为各一张表，显式保留去重域、状态和保留策略；不受表数指标驱动。
核心同提交矩阵见TECHNICAL_DESIGN B8-R2；API影响见API_CONTRACT B8-R2。

## B8-D1 目标映射与一致性不变量（内部设计已审查，未应用DDL）

本节为当前35表的迁移盘点，后文原表名仍为当前SQL事实；目标以B8-R2更新为准，不再要求一对一保留。
acquisition/fulfillment按R2合并；receipt/outbox及价格按R3统一，下表覆盖当前全部表去向，不创建第二可编辑Schema。
每表资源主键改`id UUID`、应用生成；同仓资源引用改对应`*_id UUID`，跨仓opaque身份保持原语义。现金`currency`列目标为`currency_code`；非现金积分单位另按R2建模，不能机械改名。
表/约束/索引采用billing owner命名且UTF-8名称不超过PostgreSQL63字节；新的精确SQL生成后必须全catalog复验，不手工维护第二份字段快照。

| 当前canonical表 | 目标表 | 唯一写入组件的归属 |
|---|---|---|
| `entitlement_credit_account` | `billing_credit_account` | credit |
| `entitlement_credit_grant` | `billing_credit_grant` | credit |
| `entitlement_credit_hold` | `billing_credit_hold` | credit |
| `entitlement_credit_hold_allocation` | `billing_credit_hold_allocation` | credit |
| `entitlement_credit_journal` | `billing_credit_journal` | credit |
| `entitlement_usage_event` | `billing_usage_event` | metering |
| `entitlement_usage_settlement` | `billing_usage_settlement` | metering |
| `entitlement_command_receipt` | `billing_command_receipt` | database/CommandReceiptRepository namespace=general |
| `entitlement_outbox` | `billing_outbox` | database/OutboxRepository credit |
| `payment_provider_event` | `billing_provider_event` | payment |
| `payment_settlement` | `billing_payment_settlement` | payment |
| `payment_reversal` | `billing_payment_reversal` | refund |
| `entitlement_acquisition` | 合入 `billing_credit_fulfillment`，删除独立表 | credit / R2永久授权 |
| `entitlement_fulfillment` | `billing_credit_fulfillment` | credit |
| `payment_outbox` | 合入 `billing_outbox` | database/OutboxRepository namespace=payment |
| `entitlement_fulfillment_reversal` | `billing_credit_fulfillment_reversal` | credit |
| `payment_checkout` | `billing_checkout` | checkout |
| `entitlement_audit_event` | `billing_audit_event` | database/AuditAppender |
| `entitlement_offer` | `billing_offer` | checkout |
| `entitlement_offer_revision` | `billing_offer_revision` | checkout |
| `entitlement_usage_price_revision` | `billing_feature_price_revision` | metering / R3完整销售快照 |
| `entitlement_usage_price_rate` | `billing_feature_price` | metering / R3按次价格 |
| `payment_provider_account` | `billing_provider_account` | payment |
| `payment_customer_binding` | `billing_customer_binding` | payment |
| `payment_provider_subscription` | `billing_provider_subscription` | subscription |
| `payment_subscription_period` | `billing_subscription_period` | subscription |
| `entitlement_subscription_term` | `billing_subscription_term` | subscription |
| `payment_command_receipt` | 合入 `billing_command_receipt` | database/CommandReceiptRepository namespace=payment |
| `entitlement_redeem_campaign` | `billing_redeem_campaign` | credit |
| `entitlement_redeem_code_batch` | `billing_redeem_code_batch` | credit |
| `entitlement_redeem_code` | `billing_redeem_code` | credit |
| `entitlement_redeem` | `billing_redeem` | credit |
| `entitlement_billing_command_receipt` | 合入 `billing_command_receipt` | database/CommandReceiptRepository namespace=admission |
| `entitlement_billing_admission` | `billing_admission` | metering |
| `entitlement_execution_event` | `billing_execution_event` | metering |

Credit表只被Credit具名Repository更新；Payment/Refund/Metering/Subscription取得公开业务结果而非数据库model。Audit/receipt/outbox三种支持能力仅负责存储不变量，
不取得独立业务owner。payment原有aggregate_type+aggregate_id+event_type唯一性以namespace=payment partial UNIQUE保留；credit域不被暗加同一唯一性。

### ID、字段与无外键关系

- Allocation由复合主键改应用UUID `id`，原hold/grant组合仍为UNIQUE；Execution新增内部UUID `id`，原tenant+外部event_id保留UNIQUE。
- 同仓外键式引用不创建FK/REFERENCES；每次写入在同一事务内校验tenant、存在性、state与owner引用，reconciliation检测漏项。
- tenant_id、subject_id、actor、invocation/execution/source/provider外部identity、command identity与cursor不能仅因名字含id就改UUID。
  polymorphic source_ref保持opaque并由source_kind解释；不得把外部业务identity与新内部资源PK混用。
- 默认TEXT；具有明确线上合同长度、定长hash/currency或范围语义的列保留明确长度/CHECK，不能不经字段契约审核扩大输入。
  所有金额/credit BIGINT及CHECK、唯一性、nullable语义、timestamp精度、partial predicate随迁移保留；JSON不承载可查询状态机真源。
- v1当前允许caller自选非UUID settlement_id、offer revision/admission输入；这些与UUID PK的切换受API_CONTRACT的B8-D2约束。
  本节不批准原地ALTER有数据环境或给v1偷偷加UUID验证。fresh install只对本任务独占空库进行。

### usage–hold：内部UUID与稳定绑定分开

Root选择在`billing_usage_event`增加可空`credit_hold_id UUID`，非空建立UNIQUE（credit_hold_id globally唯一，所有访问仍限定tenant）。
独立外部usage event可以为NULL；由hold派生的event必须在第一次创建时保存该引用，ID由应用随机UUID产生，不再拼接hold:UUID作为资源ID。
`ensureUsageEventForHold`在同一tenant/hold下返回已存event UUID，输入subject/feature/quantity/dimensions/source漂移报conflict；
它必须经Credit公开hold快照校验subject/feature与当前状态，不能只信caller source字符串。
从独立event首次绑定hold时，必须在事务内校验两方scope和业务字段，条件更新NULL→该hold；已非NULL只允许同值重放。
一个hold换另一个event或一个event换另一个hold均冲突；创建settlement必须同时确认usage_event.credit_hold_id等于本次hold；NULL首次绑定也在该事务完成。
原settlement UNIQUE(credit_hold_id)与UNIQUE(usage_event_id)继续保留，不能以两项各自UNIQUE替代event上绑定一致性检查。
不删除原UNIQUE(tenant_id,source_event_id)，来源身份不复用内部随机ID；source字段是稳定业务身份而非可换key避重的工具。

### Inbox与lease增量（唯一状态owner）

- `billing_provider_event`新增可空processing_token UUID（attempt fence），processing_attempts仍非负。其lease由唯一payment outbox拥有，不增加重复inbox lease。
  beginAttempt提交attempt/token；终态processed/ignored不可被旧失败覆盖；provider状态仍用received/processed/ignored/failed，token本身不暗示已完成。
  inbox payload/hash/tenant/provider/external event identity入库后不可变；retry只更新受控处理状态，不重解释已验证的provider身份。
- `billing_execution_event`自己是队列：增加lease_token UUID、lease_until TIMESTAMPTZ(3)、attempts INTEGER、next_attempt_at TIMESTAMPTZ(3)、
  dead_lettered_at TIMESTAMPTZ(3)与受控last_error_code；保留received/processed/failed状态，dead-letter是failed且dead_lettered_at非空。
  claim谓词为未processed、未dead-letter、next_attempt到期且lease空/过期；建立与此谓词对应的dispatch索引。
- 合并后的outbox保留现有lease/attempt/dead-letter语义，published_at改completed_at；增加attempt>=0、token/until成对、completed与dead_letter互斥等合法状态CHECK，
  具体CHECK与真实状态迁移一起复核。claim达到预算后不再执行handler；payload decode失败也经过fenced retry/dead-letter。
- 永久成功receipt/result与业务effect同提交；失败attempt日志是独立事实，不把已回滚的成功审计/业务receipt重新提交。

尚未放行：HTTP settlement/refund后续终态、Checkout durable网络恢复、全量retention/append-only数据库角色，以及breaking资源输入切换。
上述目标不声称全部数据设计已完成；下一文档/契约门须把这些关闭后才授权整体业务切换。

## 1. 存储边界

- Billing 使用 PostgreSQL 16 持久化全部账务事实；Redis 不保存余额、账本、payment status 或 durable receipt。
- Schema 共有 35 张表：10 张 `payment_*`、25 张 `entitlement_*`。
- 所有 tenant-owned 查询/写入必须显式携带 `tenant_id`。跨仓 ID 是 opaque reference，不是外键。
- 数据库时间为 `TIMESTAMPTZ(3)`；money/credit 为 integer minor unit/micros + currency。
- V1 不使用 `FOREIGN KEY` / `REFERENCES`，也没有 migration 链。

## 2. 当前 canonical 表 owner inventory

本节及随后关系/约束盘点描述当前SQL与原实现；目标物理模型以B8-R2及后续目标章节为准。

### Credit、usage 与 admission

| 表 | Owner 事实 / 生命周期 |
|---|---|
| `entitlement_credit_account` | tenant + subject 的 credit projection、held、generation 与状态 |
| `entitlement_credit_grant` | 来源唯一的 credit lot、有效期、burn priority、remaining 与状态 |
| `entitlement_credit_hold` | idempotent reservation、requested/captured/released、expiry 与状态 |
| `entitlement_credit_hold_allocation` | 一个 hold 在 grant lot 之间的分配与终态金额 |
| `entitlement_credit_journal` | account append-only delta 与稳定 sequence |
| `entitlement_usage_event` | tenant-scoped usage inbox identity、处理状态及 nullable UNIQUE credit_hold_id；派生 UUID 与来源身份分离 |
| `entitlement_usage_settlement` | hold 与 usage event 的一对一结算结果 |
| `entitlement_billing_admission` | invocation 的定价、mode、hold、accepted receipt 引用与状态 |
| `entitlement_execution_event` | Agent/Model/Studio execution inbox、payload hash 与状态 |
| `entitlement_command_receipt` | 通用 entitlement command replay fact；expiry 使用 batch command identity |
| `entitlement_billing_command_receipt` | admission/capture/release/execution-event ingress 的 surface-aware replay fact |
| `entitlement_outbox` | entitlement side-effect delivery、lease、attempt、publish/dead-letter 状态 |
| `entitlement_usage_price_revision` | tenant pricing policy revision 与生效窗口 |
| `entitlement_usage_price_rate` | revision 下按 feature/label 的 rate 与 reservation |

### Catalog、fulfillment、subscription 与 redeem

| 表 | Owner 事实 / 生命周期 |
|---|---|
| `entitlement_offer` | tenant 内稳定 offer identity 与启停状态 |
| `entitlement_offer_revision` | 不可混淆的报价 revision、money/credit snapshot 与发布/删除状态 |
| `entitlement_acquisition` | payment/subscription/admin/redeem 等来源形成的 entitlement acquisition |
| `entitlement_fulfillment` | acquisition 是否已 committed/reversed/reconciliation-required |
| `entitlement_fulfillment_reversal` | payment reversal 到 fulfillment reversal 的一对一事实 |
| `entitlement_subscription_term` | provider period 投影出的 tenant/subject entitlement term |
| `entitlement_redeem_campaign` | redeem program、额度、时间窗与使用上限 |
| `entitlement_redeem_code_batch` | operator 发行批次与审计原因 |
| `entitlement_redeem_code` | tenant-scoped code hash、状态与兑换者 |
| `entitlement_redeem` | code、recipient、grant 与 idempotency 的兑换事实 |
| `entitlement_audit_event` | operator action 的 append-oriented 审计记录 |

### Payment、checkout 与 subscription

| 表 | Owner 事实 / 生命周期 |
|---|---|
| `payment_checkout` | subject checkout、quote hash/snapshot、provider session 与状态 |
| `payment_provider_account` | provider external account 到单一 tenant 的映射 |
| `payment_customer_binding` | subject 与 provider customer 的绑定 |
| `payment_provider_event` | 已验证 provider inbox、payload hash、attempt/error 与处理状态 |
| `payment_settlement` | provider payment settlement、金额、currency 与结果 |
| `payment_reversal` | provider reversal/refund、金额、原因与结果 |
| `payment_provider_subscription` | provider subscription identity 与状态 |
| `payment_subscription_period` | subscription period window 与状态 |
| `payment_command_receipt` | payment command replay fact；settlement 与 refund 使用各自业务 command identity |
| `payment_outbox` | payment side-effect delivery、lease、attempt、publish/dead-letter 状态 |

## 3. 关系维护

Schema 不用 FK，因此建立关系必须按以下顺序：

```text
tenant-scoped existence
  -> caller permission / owner check
  -> current state check
  -> deterministic row lock
  -> relation + fact + journal/outbox in one transaction
  -> local UNIQUE/CHECK
  -> reconciliation
```

典型关系：

- account -> grant -> hold allocation -> hold/usage settlement/journal；
- offer -> offer revision -> checkout -> settlement -> acquisition -> fulfillment -> grant；
- provider account -> provider event/checkout/subscription；provider account external identity用于 webhook tenant resolution；
- provider subscription -> period -> entitlement subscription term；
- reversal -> fulfillment reversal -> credit reversal/exposure；
- admission -> hold -> execution event/capture/release receipt。

所有同 owner JOIN 同时连接 tenant lineage；跨仓关系只保留 opaque ref 并由 owner API/context 校验。

## 4. 账务不变量

- `credit_account.available_micros` 与 `held_micros` 非负；写路径用条件 UPDATE 和 generation 防止 projection 下穿。
- Grant：`0 <= remaining_micros <= original_micros`；expiry 晚于 effective time。
- Hold/allocation：captured + released 不超过 requested/held；一个 active hold 最终 capture、release 或 expire。
- Usage settlement：一个 hold 和一个 usage event 各最多对应一个 settlement。
- Journal：delta 非零，account 内 sequence 唯一，同 tenant/source/kind 只写一个事实。
- Money：checkout/settlement/reversal amount 为正，currency 匹配三位大写格式。
- Offer/pricing published 状态要求 publish time；revision/window 唯一且时间窗合法。
- Receipt：同 tenant/command/idempotency key 唯一，并保留 payload hash、status 与 result；需要独立业务命令身份的 surface 还写
  `command_identity`，非空 identity 在 tenant/command 内唯一。
- Settlement receipt identity 为 `settlement_id`；expiry receipt identity 为 `batch_id`。两者的 SHA-256 digest 都包含 command
  version 和规范化字段，result JSON 是 durable replay authority。
- Admission receipt 在 key/command 外增加 `api_surface`；authorize/capture/release/execution-event identity 依次为 invocation、admission、
  admission 与 event ID。Capture/release 的完整 runtime payload 和 execution-event 的 `Idempotency-Key` 均进入 receipt。
- Refund receipt identity 是 provider + external reversal reference 的 canonical digest；checkout 以 tenant/key 唯一的
  `payment_checkout.quote_hash` 保存 versioned command digest。Checkout digest 在当前 offer/catalog 校验之前用于 existing replay。
- 这些 command 的 object payload 递归 canonicalize：object key 顺序不参与 digest，array 顺序参与，非 JSON 值在持久化前拒绝。
- 当前 receipt claim/effect/result 同事务提交，不存在可见 lease/fence reclaim；正常失败回滚 claim。历史 `processing|unknown|failed`
  仅是稳定诊断 outcome，不能据此重新执行 side effect。Succeed receipt 的 `result_json` 缺失或 shape 损坏属于数据库不变量事故。
- `command_identity` 保持 nullable，只因同一通用 receipt 表还服务没有独立业务 identity 的其他 command；partial unique index
  只约束非空值，不削弱 key unique。
- Provider event：同 tenant/provider/external event 唯一；payload hash 冲突不能当作重放。
- Admission：同 tenant/invocation 和同 tenant/idempotency key 唯一；unknown 不隐式 capture/release。

Application 将 journal、audit、inbox/outbox 视为 append-oriented facts；Schema 当前没有 trigger/privilege 在数据库层阻止直接
UPDATE/DELETE，因此生产数据库角色和审计策略仍需补齐该防线。

## 5. UNIQUE 业务语义

| 约束组 | 业务语义 |
|---|---|
| `uq_entitlement_credit_account_subject` | tenant 内一个 subject 只有一个 account |
| `uq_entitlement_credit_grant_source`、`uq_entitlement_acquisition_source` | 同一来源/program 不重复发放或 acquisition |
| `uq_entitlement_credit_hold_idempotency` | tenant 内 reservation key 唯一 |
| hold allocation composite PK | 一个 hold 对一个 grant 只有一条 allocation |
| `uq_entitlement_credit_journal_sequence`、`uq_entitlement_credit_journal_source` | account sequence 与来源事实各自唯一 |
| `uq_entitlement_usage_event_source` | tenant 内 source event 只接收一次 |
| `uq_entitlement_usage_event_hold` | 非空 credit_hold_id 只绑定一个 usage event；scope/state 在 owner 事务内校验，无 FK |
| `uq_entitlement_usage_settlement_hold`、`uq_entitlement_usage_settlement_event` | hold 与 usage event 均只能结算一次 |
| entitlement/payment/Billing receipt key UNIQUE | 每个相应 command surface 的 tenant + command + idempotency key 只保留一个 receipt |
| `uq_entitlement_command_receipt_identity` | 非空 entitlement command identity 在 tenant + command 内唯一；当前约束 expiry batch |
| `uq_entitlement_billing_receipt_identity` | 非空 admission/execution command identity 在 tenant + surface + command 内唯一 |
| `uq_payment_command_receipt_identity` | 非空 payment command identity 在 tenant + command 内唯一；当前约束 settlement 与 refund |
| `uq_payment_provider_event_external` | tenant/provider external event 去重 |
| `uq_payment_settlement_external`、`uq_payment_reversal_external` | provider payment/reversal identity 去重 |
| `uq_entitlement_fulfillment_acquisition` | acquisition 只履约一次 |
| `uq_payment_outbox_source_event` | aggregate 的同类 payment event 只入 outbox 一次 |
| `uq_entitlement_fulfillment_reversal_payment` | payment reversal 只产生一个 fulfillment reversal |
| `uq_payment_checkout_idempotency` | tenant 内 checkout key 只对应一个 quote/result |
| `uq_entitlement_offer_site_key` | tenant 内 offer key 唯一（约束名保留 `site` 历史词，字段语义已是 tenant） |
| `uq_entitlement_offer_revision_number` | offer revision number 唯一 |
| `uq_entitlement_usage_price_revision_site_number` | tenant pricing revision number 唯一（约束名保留 `site` 历史词） |
| `uq_entitlement_usage_price_rate_identity` | revision + feature + nullable label 的 rate identity |
| `uq_payment_provider_account_external` | provider external account 全局只映射一个 tenant |
| `uq_payment_customer_binding_external` | provider account 内 external customer 唯一 |
| `uq_payment_provider_subscription_external` | tenant/provider subscription identity 唯一 |
| `uq_payment_subscription_period_window` | provider subscription 的同一 period window 唯一 |
| `uq_entitlement_subscription_term_period` | provider period 只投影一个 entitlement term |
| `uq_redeem_campaign_key`、`uq_redeem_code_hash` | tenant 内 campaign key 与 code hash 唯一 |
| `uq_redeem_code_once`、`uq_redeem_idempotency` | code 只兑换一次；recipient command 可安全重放 |
| `uq_entitlement_admission_invocation`、`uq_entitlement_admission_idempotency` | invocation 与 admission command identity 唯一 |
| execution event composite PK | tenant 内 event ID 唯一 |

注意：PostgreSQL 的普通 UNIQUE 允许多个 NULL；`usage_price_rate_identity` 的 nullable `label_key` 不能单独证明
“每个 feature 只有一个 NULL label”。当前 repository 查询按 revision 降序/ID 收敛，但若该业务唯一性必需，后续需显式
NULLS NOT DISTINCT 或等价约束设计。

## 6. 查询索引

Canonical Schema 当前定义 14 个显式 index：11 个查询/dispatch access path，加 3 个 receipt command identity unique index。

- grant expiry、hold expiry；
- entitlement/admission/payment receipt command identity；
- entitlement/payment outbox dispatch；
- provider event processing；
- settlement by checkout、reversal by settlement、checkout by status；
- subscription term by subject；
- admission by status、execution event processing。

PK/UNIQUE 自带索引，不重复声明。索引用途变化必须同时更新查询、Schema、integration test 与本文。

## 7. JSON 与敏感数据

`quote_snapshot_json`、provider/event payload、receipt、outbox、dimensions、metadata 与 audit payload 使用 JSONB。它们是边界快照或
扩展 metadata，不替代 tenant、状态、金额、关系或查询字段。Provider/receipt payload 可能包含敏感数据；日志不得输出完整值，
访问与 retention 应按最小权限管理。

## 8. Retention、备份与删除现状

- Schema 未实现 partition、TTL、archive table 或 GC job。
- Outbox 有 published/dead-letter 状态但无自动清理；provider/execution inbox、receipt、audit 和 journal 也无仓内 retention job。
- Offer revision 有显式 soft-delete 字段；其余表的删除语义由各自状态表达，未提供通用 soft delete。
- 仓内没有备份策略、RPO/RTO 或 restore drill 证据。

上线前必须由 Billing owner 与合规/运维明确每类事实的保留期、legal hold、脱敏/删除语义、备份加密与恢复验证；在此之前不得
执行临时 DELETE 清理账务事实。


## B6b 隔离数据承接证据

当前canonical SQL与生成schema未变。新增真实Prisma测试覆盖账户typedCRUD/BigInt精度与UTC毫秒、receipt的DbNull/JsonNull，
receipt/account/journal/outbox单事务提交/回滚/外连接不可见；key UNIQUE与partial identity UNIQUE独立反例，跨tenant正例。
行锁与SKIP LOCKED带tenant条件，真实pg_stat_activity锁等待后释放；具体预算错误语义见TECHNICAL_DESIGN末尾。
这证明当前映射可承接所测能力，不代表35表所有用例已重写；生产pg writer、共享receipt/audit/outbox公开面及B8命名切换仍待实施。

## B8-S0局部数据门

Schema、字段和当前writer不变。付款准入仅阻止尚未付款或非一次性payment事件进入既有settlement/fulfillment事务；
被忽略事件仍可持久化inbox并由outbox正常完成，但不得写payment_settlement、credit_account、credit_grant或credit_journal。
同Checkout后续paid async事件才使用原payment外部identity/inbox去重与现有账务事务；真实PG断言零提前发放和单次后续发放。
这不声称B8目标35表已经应用，也不修复其他已知事务/订阅问题。局部schema命令验证当前SQL无变化即可，不创建新migration/DDL。


## B8-D2a Checkout恢复数据增量（内部设计已审查，未应用DDL）

不增加第36张业务表；现payment_checkout→billing_checkout按B8-D1映射，由Checkout唯一writer。
以下为已有事实的生命周期所需增量，精确DDL仍只在canonical schema实现；不是第二份可编辑SQL。

| 数据组 | 目标字段/类型与理由 |
|---|---|
| 账户引用 | provider_account_id UUID引用Payment owner映射；provider/provider_account_ref与provider_environment（test/live）为已接受请求的不可变快照，不代替Payment账户authority |
| 请求身份 | provider_idempotency_key TEXT、provider_request_json JSONB、provider_request_digest CHAR(64)；快照含固定策略/API版本、完整params、关联身份与checkout_session_mode（payment/subscription），无密钥；同checkout永不改key |
| 两个截止 | 原expires_at改quote_expires_at TIMESTAMPTZ(3)；新增provider_session_expires_at可空TIMESTAMPTZ(3)，仅确认provider结果才填，二者语义独立 |
| 创建状态 | session_creation_status TEXT：not_started/in_flight/unknown/ready/failed/review_required；不替换付款业务status，ready不表示paid |
| 尝试与恢复 | session_attempts INTEGER非负；session_attempt_token可空UUID；session_lease_until/first_attempt_at/retry_deadline_at/next_attempt_at可空TIMESTAMPTZ(3)；状态机使用数据库clock_timestamp |
| 历史不确定性 | session_had_unknown BOOLEAN NOT NULL DEFAULT false，unknown记账/过期in_flight接管/同SDK调用内部传输未知时置true，永不清零，不由当前status推断 |
| 诊断 | session_last_error_code与provider_request_id可空TEXT；仅稳定安全错误/请求定位，不存完整provider错误响应、Authorization或URL查询敏感内容 |
| 已确认结果 | 既有provider_session_id/checkout_url，新增provider_session_status可空TEXT（open/complete/expired）；URL是敏感session能力，日志不输出，读取限受信owner/subject；ready后session_id不可替换 |

约束目标：provider_request_json须JSON object；digest/key非空；in_flight必须token/lease/first_attempt_at/deadline齐全；
非in_flight lease清空，attempt token保留最后身份供诊断但不具写入权。not_started要求attempts=0且token/first_attempt_at/deadline均NULL；
unknown要求attempts>0且first_attempt_at/deadline/next_attempt_at非NULL；ready/failed/review_required不留next_attempt_at。ready必须非空session_id及provider状态，
URL允许NULL（provider已complete/expired），unknown/review允许缺session ID；lease_until>本attempt领取时钟由应用检查，retry_deadline_at>first_attempt_at由CHECK兜底。
provider/account/provider_environment/checkout_session_mode/request key/digest在首次prepare后禁止修改；JSON结构按版本校验，生成Prisma不替代CHECK。CHECK要求failed时session_had_unknown=false；
flag=true后无论当前in_flight或unknown都不得按4xx转failed；合并本地SDK内部uncertainty与持久flag，旧token不能覆盖新状态。
恢复预算用first_attempt_at及持久attempts，第一次claim前可为NULL；prepare行即持久可领取，不依赖Redis/outbox提醒。
保留UNIQUE(tenant_id,idempotency_key)，新增provider账户scope下非NULL session_id UNIQUE以及provider账户scope下provider_idempotency_key UNIQUE，
scope采用非NULL provider_account_id，不用nullable external ref绕过UNIQUE。目标billing_provider_account增加provider_environment（test/live），
有效执行账户external_account_ref非空，UNIQUE(provider,provider_environment,external_account_ref)确保单一tenant映射；自身UUID供Checkout引用。
Stripe主账户同样保存实际acct身份；是否传Stripe-Account是请求配置，不用NULL代表未知账户。平台/Connect凭据以实际执行账户核验后绑定，
Checkout持久provider_account_id、环境与执行账户快照；credential轮换不得改变这些身份。此处是既有Payment表的生命周期增量，不新增第36表。

查询：tenant+id用于请求/query/finalize；跨tenant worker仅在内部固定scope扫描not_started、到期unknown及过期in_flight，
候选索引按各分支的next_attempt_at或session_lease_until+id建立partial predicate；不是对OR条件盲建单个全表索引。
worker带tenant/fence作条件更新，SKIP LOCKED与确定排序；外部查询始终tenant+subject。Payment账户关系无FK：prepare经owner同事务查询，
账户映射不得物理删除被Checkout/settlement/inbox引用的事实，停用与保留分开；reconciliation在同一只读快照通过两个owner比对orphan。

有财务效果或unknown/review/未完成session的Checkout不得物理删除，也不能清provider key/digest使旧请求重新创建。
完整保留期/法域与敏感URL清理归统一retention门，不在本轮硬编码法定年限；日志不记payload/token，清URL不清session identity和付款事实。
请求body/secret配置不入contract；quote字段与provider截止的wire改名/新增遵守API major门。此处内部字段未成为当前SQL事实。

## B8-D2c退款观察与冲正数据目标（内部设计R2已审查，SQL未应用）

与TECHNICAL_DESIGN的D2c两阶段一致；沿用既有退款事实边界，履约结构按R2合并，不新建平行退款/ledger事实源。

| 现有→目标表 / writer | 字段与约束增量目标 |
|---|---|
| payment_settlement→billing_payment_settlement / Payment | provider_account_id非NULL UUID；external_charge_ref/external_payment_intent_ref可空TEXT，仅经受信付款证据写入。账户scope下非NULL charge ref唯一，PI按账户scope索引但不先假定一PI永远只一charge；仅PI的关联需查询结果唯一且其他身份/金额一致，否则review |
| payment_reversal→billing_payment_reversal / Refund | provider_account_id非NULL UUID，external_reversal_ref非空TEXT为真正Refund.id；UNIQUE(provider_account_id,external_reversal_ref)，tenant必须与Payment账户owner一致；settlement_id引用准确付款，无FK。amount_minor正BIGINT，currency_code与付款一致；身份/金额/币种/付款关联一旦接受不可改 |
| 同上 / Refund | status区分无可信渠道证据的unknown与已接受渠道观察pending/requires_action/succeeded/failed/canceled；新事件证据仍在ProviderInbox。observed_provider_event_id/observed_at记录来源，不能用observed_at或Event.created假装资源版本；不支持的对象/状态留inbox复核，不伪造succeeded |
| 同上 / Refund | credit_effect_status=waiting_provider/pending/applied/review_required/not_applicable；credit_effect_completed_at可空TIMESTAMPTZ(3)，credit_effect_error_code可空TEXT；review_required另有review_reason_code可空TEXT以允许applied后出现渠道失败仍保留已应用状态并标review；refund级待复核由该标记表达 |
| 同上 / Refund | credit_fulfillment_id/credit_grant_id可空UUID，仅从Credit返回的精确同tenant/付款来源绑定，首次应用后不变；allocation_policy_version可空TEXT，未绑定/策略不支持不得自动apply；reason改为业务说明TEXT，不拼allocation_mode伪装结构化字段，审计actor来自受信上下文 |
| entitlement_fulfillment_reversal→billing_credit_fulfillment_reversal / Credit | 保留同一payment_reversal_id唯一；成功结果记录policy_version、input_digest、refund_amount_minor、prior_refund_amount_minor、prior_credit_micros及原G/S快照（类型/非负与正数按各自语义），让每笔delta及处理顺序可重建。amount_micros允许0；journal_id可空UUID，committed正delta必须非NULL且对应同tenant/source/负delta journal，零delta必须NULL |
| payment_outbox→billing_payment_outbox / OutboxRepository | 既有列承接RefundCreditEffectRequested(v1)，aggregate identity为Refund；去重不靠event delivery ID。与Refund pending在T1同提交，T2成功结果独立于ack，重放读取Credit结果；既有Recorded不再被误称可驱动执行 |

状态约束：applied必须有completed_at及绑定的fulfillment/grant/policy；applied后原成功Credit结果不可覆盖或删除，后续渠道失败只更新观察和review标记。
not_applicable只允许有明确“该商品无Credit效果”的可信报价/履约政策证据；缺grant、映射未到、订阅策略未定义一律不能据absence设置not_applicable。
waiting_provider是渠道未成功且无历史已应用结果；pending是已确认succeeded且具备执行输入；review_required可用于成功观察尚无可应用映射/余额不足等零Credit效果情形。
已有applied后即使渠道状态failed也不能改waiting_provider；原冲正账目在累计计算中继续参与。存在未解决review的settlement暂停新增自动效果。
源事件重放沿inbox key，记录命令重放沿receipt key；refund identity相同的不同事件不是命令payload冲突本身，状态观察可更新，金额/关联漂移另报review。

T1 ProviderEvents effect复用其外层inbox事务，不claim第二份Refund command receipt；可信succeeded观察才可同提交观察/inbox终态/唯一任务outbox。独立record root只claim自己的receipt，无可信观察时unknown+waiting_provider、零任务；已存在provider结果不被record重放降级。T2原子提交Credit全组+Refund效果状态。信用不足不回滚已提交T1；SQL异常不在同tx吞掉后补写状态。
金额额度检查在settlement锁内；失败回流后曾applied金额不从Credit累计中扣除。新外部退款请求的额度预占/取消恢复另属创建命令设计，不能复用SUM(status=succeeded)假装已覆盖在途外部退款。

退款应用查询通过tenant+id和account scope+external_ref；累计Credit已应用金额通过settlement对应Refund集合JOIN fulfillment reversal的成功结果，不能过滤渠道当前status；明确同tenant/no-orphan关系。
与Grant相关的在途hold占用为SUM(held_micros-captured_micros-released_micros)，由Credit在account/grant锁内查询；query索引按现有allocation的grant scope检查执行计划后决定，不凭字段机械加索引。
delta=0需既定身份/绑定/累计/策略检查，本退款链先前冲正耗尽的grant允许保存成功结果；不要求free余额。expired/revoked即使零delta仍review，不自动恢复权益。正delta才检查可扣状态/freeMicros/account.available及执行余额变更。
正delta同事务journal.source_kind=payment_reversal/source_ref=refund.id，序号受account锁保护；zero delta只写成功结果，禁止通过JOIN journal来判断所有退款是否已应用。

无FK关系由owner受信绑定与同事务检查保证：退款→账户/付款、效果→退款/fulfillment/grant/journal，后台Reconciliation只能经owner只读快照核orphan/金额/效果状态。
有渠道成功、pending任务、applied、review或未知事实的Refund及其inbox/receipt/履约证据不能按普通缓存TTL删除；完整retention权限策略仍待单独收敛。
本表是待编入唯一canonical SQL的目标，不声称现有VARCHAR、状态CHECK、amount>0或生成Prisma已经支持这些状态；fresh install/catalog/Prisma/真实数据演进与完整事务验证仍待实施。

## B8-D2d订阅数据承接目标（机制R2已审查，商业资格/SQL未放行）

保持Subscription/Credit分工，履约两表按R2合并；不把三张订阅表变成第二套Payment invoice/payment ledger。原始渠道Invoice/InvoicePayment观察保存在Payment拥有的inbox；Subscription保存本周期资格所需的不可变证据快照与来源引用，而非任意账单CRUD真源。

| 现有→目标表 / writer | 承接字段与约束目标 |
|---|---|
| payment_provider_subscription→billing_provider_subscription / Subscription | UUID id，非NULL provider_account_id，UNIQUE(provider_account_id,external_subscription_ref)。tenant/subject/checkout_id与固定offer_revision_id在可信绑定后不可因metadata事件覆盖；保存program/credit额度/币种/interval及policyVersion的报价快照与digest。subscription_item_ref、provider_price_ref初次可信校验后绑定，后续变化review |
| 同上 / Subscription | provider_status分别表达incomplete/incomplete_expired/trialing/active/past_due/canceled/unpaid/paused与unknown；last_observation_event_id、observed_at及review_reason_code用于证据。周期不在这里压成唯一current_start/end；event时间不是严格资源版本 |
| payment_subscription_period→billing_subscription_period / Subscription | UUID id，provider_subscription_id、provider_account_id、subscription_item_ref、external_invoice_ref、external_invoice_line_ref、program_key、period_start/end及固定quote/policy digest。完整身份后建行；UNIQUE(provider_account_id,external_invoice_ref,external_invoice_line_ref)和UNIQUE(provider_subscription_id,subscription_item_ref,period_start,period_end,program_key)，end>start |
| 同上 / Subscription | invoice_status/settlement_evidence_kind、source_event_id、独立证据摘要与具名JSON object快照；资金证据为受账户scope校验的InvoicePayment ID、其分配给本Invoice的amount_paid/currency及Payment settlement引用（若确有），不以PI总额冒充分配额。零额/站外等分类允许无Payment settlement，不能造正数支付。快照只保留资格所需Invoice/line标识、已校验金额/币种/数量/父关联与结清方式，不存秘密/完整客户payload；JSON version/schema受运行时验证。Invoice paid不强制附一条虚构Payment settlement，实际资金事实另经Payment能力确认 |
| 同上 / Subscription | grant_status=waiting_evidence/waiting_period_start/pending/applied/review_required，grant_error_code、grant_completed_at可空；applied要求成功Credit结果引用及授权digest，不能因provider当前状态/旧事件覆盖。waiting_period_start任务的next_attempt_at在现payment outbox，period不再复制一套lease/attempt |
| entitlement_subscription_term→billing_subscription_term / Subscription | UUID id，source_period_id唯一且同tenant；subject/program/start/end/grant_micros来自该period冻结授权。生命周期/显示状态与Credit applied分开表达，不以subscription状态覆盖历史grant额度；grant_micros非负，实际可授予数量由已批准policy决定 |
| Credit fulfillment/grant/journal / Credit（R2合并授权） | 来源统一subscription_period+period.id，基于固定授权digest重放；不读provider DTO/Subscription repository。当前profile每个source仅一个program/一次发放，按R2收紧fulfillment来源唯一性并保留journal去重；成功result校验先于当前expires/offer/订阅状态；amount/subject/account/program/window漂移冲突 |
| payment outbox / OutboxRepository | SubscriptionCreditGrantRequested(v1)按period identity唯一，payload为tenant/period/schemaVersion。只有具备批准policy与完整证据的T1可enqueue，future start通过next_attempt_at表达等待；ack丢失读成功结果恢复，不补第二份grant |

字段缺失到不能建立完整period身份时不创建占位id/window=now的周期；证据仍在inbox，沿D1记录明确缺失关联错误并有界重试/最终dead-letter，不能标ignored假装处理完毕。
同一完整period尚待付款/资格时可以waiting_evidence存在而不enqueue；新证据到达经owner重新评估同period，不换external invoice/line或Credit source identity。重开invoice与同周期不同line先review，不覆盖已applied结果。
T1复用ProviderEvents outer transaction，不新claim Subscription command receipt；Subscription事实/period+inbox终态+合格任务同提交。T2锁period/term→account→grant等，Credit全组+period/term成功结果同提交。
如果期初任务首次执行时窗口已过期，保留证据并review；成功重放跨过期仍返回同结果，数据库时钟只影响首次可发放资格，不污染永久幂等。
T1合格时now<start明确waiting_period_start+outbox next_attempt_at=start，窗口内pending，首次now>=end则review；到期handler的waiting→pending CAS与T2同事务，失败回滚不虚报pending。future等待不消费失败预算。
waiting_evidence自动补查增加next_evidence_check_at、evidence_check_attempts（非负）、evidence_check_started_at/deadline_at、evidence_generation（非负，每个接受的新证据递增）与last_evidence_check_error_code；不加第二套lease，短事务CAS推进next check/attempt后事务外GET，用attempt+claim时evidence_generation+授权digest防旧响应覆盖，provider事件使已合格/applied时不再重写。
扫描索引对已批准policy、waiting_evidence、next_evidence_check_at到期状态建立具名partial索引（实现时验证计划）；首等待deadline不被失败/重启重置。既有payment worker tick负责有界补查，12次/1小时预算耗尽显式review，清next check；新可信证据可解除仅因等待预算的review，不解除身份/政策冲突。
授权digest与证据digest分离，前者不含observed_at/Event ID等变化字段，重放输入仍保持原授权。

无FK完整性通过Checkout/Payment/Subscription/Credit公开能力验证tenant/account/subject/price/item/window/来源；账户或报价下架不是删除历史关联的授权。
查询索引对应tenant+subject+period_end/id keyset、账户scope订阅/Invoice line唯一查找、period.id应用查找；future-start调度复用outbox next_attempt索引，不新建共享Redis事实源。
Reconciliation经owner一致只读快照比对period→term→Credit授权/金额/窗口/结果，缺少invoice资金来源不靠造settlement修补。retention保留未决/已发放来源证据，保留期尚待完整设计。
本方案使用已有三表表达当前单item单服务行profile，不宣称能容纳全部通用Invoice编辑/多种资金分摊；新增商业profile如需要新事实owner/表，须独立ADR，不受“35表”数量驱动强塞字段或丢事实。


## B8-D3 权限与保留分类（目标待实施）

角色/锁/只读snapshot权威机制见TECHNICAL_DESIGN B8-D3。当前canonical没有ACL；以下当前35表清单不是已应用GRANT，也不把旧字段语义直接复制到目标。完整目标每张表与可更新列必须按D1/D2的变更重新枚举并覆盖权限门。

| 当前分类 | 表（当前物理名） | 目标注意 |
|---|---|---|
| 只发现INSERT的12表 | entitlement_credit_journal、entitlement_usage_settlement、payment_settlement、payment_reversal、entitlement_acquisition、entitlement_fulfillment、entitlement_fulfillment_reversal、entitlement_audit_event、entitlement_offer_revision、entitlement_usage_price_revision、entitlement_usage_price_rate、entitlement_redeem | 不是12表都永久无UPDATE：D2 Refund观察/status及effect需要增量状态；不可变identity/金额/结果与允许状态列分开。现有FOR UPDATE需先迁移并证明，不直接撤权限 |
| Credit可变4表 | entitlement_credit_account、entitlement_credit_grant、entitlement_credit_hold、entitlement_credit_hold_allocation | 余额/generation、remaining/status、capture/release及allocation更新；tenant/id/source/original amount受保护 |
| 回执3表 | entitlement_command_receipt、payment_command_receipt、entitlement_billing_command_receipt | 状态/result允许更新；identity/digest及永久终态回放保护，禁止因时间久清除去重 |
| 消费5表 | entitlement_outbox、payment_outbox、payment_provider_event、entitlement_execution_event、entitlement_usage_event | attempt/lease/due/处理状态允许更新，事件identity/payload与租户不可随重试重写；未决/死信不是垃圾 |
| Checkout/catalog 2表 | payment_checkout、entitlement_offer | session结果/生命周期与immutable quote/account/subject分开；配置owner决定可变字段 |
| 订阅3表 | payment_provider_subscription、payment_subscription_period、entitlement_subscription_term | 当前upsert还改subject/account/grant amount，目标D2d改不可变授权/绑定与状态分离；不能先施加不兼容ACL |
| Redeem 3表 | entitlement_redeem_campaign、entitlement_redeem_code_batch、entitlement_redeem_code | counter/status更新真实存在，不能把batch按名字当append-only |
| Admission 1表 | entitlement_billing_admission | accepted provider证据及状态有界更新；identity/授权金额/主体受保护 |
| 无当前生产writer 2表 | payment_provider_account、payment_customer_binding | 不因表存在授运行时写权；目标Payment受控配置/绑定用例批准后才授所需能力 |

初期preserve profile不清理历史账务事实、不增加TTL/归档表；R2结构合并另经数据演进门，不用retention操作代替迁移。特别保留receipt、inbox identity、payment outbox唯一身份、journal、迁移后CreditFulfillment（含原acquisition/fulfillment来源与结果）、reversal/usage settlement/redeem永久结果与历史报价；迁移前原行须完整映射，不因删表丢失，避免重复授信/扣款/冲正；无FK不替运维阻止orphan。未来维护计划必须检查双向引用、未决状态、replay范围与恢复证据，未批准不执行删除。

Reconciliation不新建第二套账本/权威投影。结果是有限一次性观察，不能拿报告重算值直接UPDATE。owner页需能查孤儿子记录、tenant不匹配、零delta无journal等目标合法关系；T1/T2待处理必须结合owner任务/截止证据，不按当前四查询把全部pending判错。

权限验收独立于35表catalog与Prisma生成：实际低权限身份读/写/行锁/事务正反例、owner成员关系/额外PUBLIC或列GRANT漂移、新表默认拒绝、生产事务在目标role下完整通过。允许UPDATE某列仍不证明状态机或tenant访问正确。
