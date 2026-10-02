## R59：本人读取 HTTP 与受信委派 D0（R66机器候选已验；未发布/生成/HTTP）

R67 当前生成候选（2026-10-02）：按 Root docs/task.md 已审范围实施两个普通 scripts，官方 Hey API 0.99.0 的 TypeScript＋schemas(json) 两插件生成 index.ts/types.gen.ts/schemas.gen.ts，closed binding/provenance 输出 provenance.json；没有 SDK/client 或手改官方产物。43 原 schema/$ref/单位 metadata 语义、双次全字节一致与只读漂移门已实测通过；原206契约全文保持，仅EOF追加33项，完整29文件804pass/0fail/0skip，15.31s。format、两noEmit编译、contract:check 17+24、sql:check、frozen install 与 generated check 均exit0。本片尚未验收：官方 types.gen.ts:19 的 CreditMicros & NonNegativeDecimal 触发现有 typed-lint 重复交叉类型规则（exit1）；audit exit1，基线6high/5moderate，当前9high/5moderate，新增3high来自生成器固定 js-yaml4.2.0。未手改生成物、放宽门禁或升级既有依赖；Root 后续裁决与独立复验待进行。下列 R59/R66“未生成/工具冻结/Phase A”是前序阶段记录，不覆盖本段当前状态；HTTP/runtime、Nest adapter/Ajv、SQL/Prisma、赠送/计价/支付、其他owner与Git/资源边界仍保持，未发布或启动服务。

Billing main 156451051f6ee47ba9b128f481f96094bfb9f731仅已发布本人read组件。当前唯一v2 YAML候选为2.0.2/24operations/24paths，两GET已声明独立JWT OR完整BFF五因素、u1/profile/auth-selection与no-store；正式Nest HTTP尚未注册。当前工作树experimental2.0.2 source/checker候选已由Root R66在Node24实测29 files、771passed/0fail/0skip（含206契约，不重复累计）、format/lint/两noEmit编译门exit0，12.42s；Sol三机器反向字节审0P0/P1/P2，日志 /tmp/kokoro-billing-r66-root-machine-green.log。候选尚未提交发布、生成或注册正式HTTP，机器治理通过不等于运行认证通过。本Phase A只对齐README provenance和四R59当前前缀；以下codec/auth为后继runtime须承接的规则，历史正文原样保留，不把admin草稿当运行权限。

### 两种明确身份分支

GET /v2/billing/me/credit-account 与 GET /v2/billing/me/credit-ledger 仍 internal-owner/read-only，无客户端account/subject selector。当前两operation机器候选的x-kokoro-permission为authenticated-user-or-web-bff，security按OR：①tenantContext+userBearer；②tenantContext+serviceCaller+internalSecret+serviceBearer+subjectContext五项AND。复用现securityScheme，不增加IAM权限，不使任意内部service获得本人代理资格；service固定web-bff，subject mandatory。

委派主体来源：IAM已发布SessionAuthorization可信response tenant_id/user_id -> BFF SessionAdmissionClient -> RequestContext.identity.namespace/userId -> 本人adapter构造tenant/subject。Billing认证BFF机器凭据后使用这组委派主体，不从body/query/cursor或服务principal的actor/sub借用本人身份。BFF过滤浏览器输入身份头且不转发用户Bearer；Billing service token及internal secret分别显式配置，缺失启动拒绝，没有凭据fallback。

机器专有标记或已配置service credential出现即要求完整五因素；缺失因素/错service/坏token/缺或空subject不得降级userBearer，统一403 billing.forbidden且零账务调用；完整机器认证后存在但编码/语义非法的身份头为400 billing.invalid_request，同样零账务调用。共同tenant header或Authorization本身不把合法JWT误分类为机器。仅无机器标记的userBearer分支验证IAM JWT issuer、固定audience、时效及tenant claim与已解码tenant header一致，subject来自验证后的sub；缺/无效JWT为401 billing.unauthenticated，已认证但tenant禁止为403。开发raw internal-header路径不进入正式runtime。

当前两GET的x-kokoro-auth-selection已记录闭集machine_markers=x-kokoro-service/x-kokoro-internal-secret/x-kokoro-subject，按header出现而非truthy；service_bearer_selects_machine:true仅指匹配已配置专用服务凭据，不以共享tenant或任意Authorization选机器分支。machine_partial_response:403与machine_to_user_fallback:false固定，其他operation拒此extension。该机器事实/守卫已验，后继HTTP仍须实际实现并验证选择优先级。

### 已裁定 canonical header profile：personal-identity-u1（R66机器已验；codec/HTTP待实施）

不把任意Unicode写入Node raw header。Root R61裁定这两个GET使用现header名，但所有身份都统一编码：`u1.` + base64url(UTF-8(identity))，无padding；ASCII身份也编码。只接受该格式，不raw/percent双读，不decodeURIComponent、不猜格式；其他operation的旧TenantId参数不跟随变更。对比percent UTF-8编码可行但最大域更长；u1有明确版本前缀、ASCII wire及较小界限。当前source/checker已承接该profile及experimental2.0.2，经Root771纯门/独立0审；该wire未发布/生成，运行codec/认证与HTTP未实施，机器治理通过不等于运行验收。

| 层 | 精确规则 |
|---|---|
| semantic身份 | tenant 1..191、subject 1..255个Unicode code point，拒NUL与孤立surrogate；不NFC/trim/剥BOM，不缩ASCII/UUID域。身份前后空格或不同规范化字节保持不同，不由transport修正。 |
| encode | 先验证semantic域，逐身份UTF-8编码，再无padding base64url，最后加literal u1.；service、secret、token头不做此身份编码。 |
| wire | 单个ASCII字符串，body alphabet仅A–Z/a–z/0–9/_/-；拒空body、padding、空白、percent、未知前缀、重复header（按rawHeaders计数/大小写无关）、数组或逗号合并值。 |
| decode | 检查wire限额及前缀/字母表，base64url解码并重新编码严格相等（拒noncanonical trailing bits）；fatal UTF-8，保留BOM而非隐式剥除；再验证code point/NUL/surrogate；UTF-8往返字节必须一致。验证后才构造受信context或调用Credit。 |
| wire限额 | tenant最大764 UTF-8 bytes，base64url最多1019，加u1.共1022字符；subject最大1020 bytes，base64url1360，加前缀共1363。最小一个UTF-8 byte为u1.加两字符，共5。191/255是decoded semantic长度，不是encoded header的JS length。 |
| 无变动 | cursor仍<=2048原始字符；账号UUID、BIGINT上界、identityDigest算法和读取权限不变。digest从decoded身份重算，绝不hash u1.header字串充当本人身份。 |

固定示例：tenant-a -> `u1.dGVuYW50LWE`，subject-a -> `u1.c3ViamVjdC1h`。不把此编码当签名/加密，机器认证/JWT仍独立必需。

当前已验machine候选精准变更仅两GET：用新components.parameters.PersonalTenantId替代两处共享TenantId ref（同header name，required，min5/max1022），新增PersonalSubjectId header参数（min5/max1363，在通用参数层optional、BFF分支mandatory，userBearer不使用它）；描述固定web-bff与u1 profile，记录两operation的 `x-kokoro-identity-transport: personal-identity-u1`，补五因素security/permission及guard断言。原TenantId/其他operation字段不改；security的subjectContext同header名，profile和必填由operation约束。参数/guard非法一致，未认证不通过参数探测获得subject。当前machine/checker为experimental2.0.2已验候选，未提交发布；本Phase A不再修改机器或运行源码。

consumer影响严格owner-first：Billing机器源及正式generated/provenance固定commit+digest -> BFF本人两读adapter编码已IAM验证context并固定Billing凭据 -> BFF public投影 -> Web同源adapter。不全局修改BFF ownerIdentityHeaders或其他owner请求，不拿用户body生成delegated subject；userBearer合法客户端也需采用已发布的tenant u1参数。没有编码fallback或旧两读wire兼容。

### 严格GET输入、响应和错误

账户GET仅允许空query；ledger query只有limit/cursor，各出现最多一次。limit省略50；HTTP字符串必须规范正十进制并落1..100，再转换为Service number；空、0、101、01、指数/小数/符号/空白、数组与重复query拒绝，不Zod全局coerce/clamp。cursor省略是首屏，显式空/非单string/>2048非法；不trim、不改token。GET body非空拒绝，不从body/header自报account/subject或重写服务输入。身份先验证，随后query/cursor预检；foreign identity cursor在SQL前拒绝，账号/实际boundary绑定仍由已发布owner内部执行。

Controller只调用CreditService.getMyAccount(context)或listMyLedger(context,page)，不ensure/refresh/write/cache。钱包null转404，disabled照常只读；有钱包无journal为items=[]/page.next_cursor=null，没钱包不是假empty。成功只按源CreditAccountResponse/CreditLedgerResponse：credit_account_id/status/available_micros/held_micros；ledger items的journal_id/sequence/delta_micros/balance_after_micros/source_kind/source_ref/created_at与page.next_cursor。BigInt全为精确decimal string、Date为ISO UTC Z，不Number/浮点、不第二手写DTO、不旧entries/extra/meta envelope。signed delta及>2^53精度沿已发布组件；next cursor原样由codec产生。

| 状态 | 唯一现machine code / retryable | 映射/副作用 |
|---|---|---|
| 200 | 源成功schema | 本人钱包/页，GET零事实写入；不receipt/replayed/Location。 |
| 400 | billing.invalid_request / false | strict query、非法identity wire（在有效认证后）、CREDIT_INVALID_QUERY/CREDIT_INVALID_CURSOR；不泄露cursor或他人账号存在。认证credential/主体绑定失败仍按401/403，不变成授权。 |
| 401 | billing.unauthenticated / false | userBearer缺失/验证失败，零账务调用。 |
| 403 | billing.forbidden / false | BFF认证因素缺失/机器凭据错误/subject缺或空、caller不匹配、认证tenant禁止，零账务调用，不降级。 |
| 404 | billing.not_found / false | 本人钱包不存在/CREDIT_ACCOUNT_NOT_FOUND，不临时建钱包。 |
| 500 | billing.internal_error / false | CREDIT_READ_CORRUPT、响应schema失败或内部不变量，安全信息，不返回SQL/原row/driver message。 |
| 503 | billing.dependency_unavailable / true | typed数据库不可用/只读预算超时等依赖失败；按稳定code/类型/SQLSTATE封闭映射，不按message猜测、不把任何错误都归503。 |

两现GET未声明504；要新增需owner另改机器，不在Filter自行发明状态。所有success/error（包括早期401/403、404/405路由错误）统一x-request-id与Cache-Control:no-store；request ID来自受控middleware，非法/多值ID拒绝或重建按唯一框架规则，不发旧x-kokoro-request-id或body meta.request_id。每个响应通过owner正规生成schema校验，拒未知字段/错误retryable/非UTC/丢精度。两GET机器候选已补七状态no-store header引用；实际HTTP含早期/路由错误的输出仍待实现，其他operation的header保持。

### 后继正规生成与closed registry（未实施）

唯一输入为本owner YAML及正式checker；已批准后继scripts/generate-billing-api.ts只调用Hey API的TypeScript＋schemas（type:json）两个官方plugins，无SDK/client。官方输出为src/generated/billing-api/index.ts、types.gen.ts、schemas.gen.ts；scripts/billing-api-artifacts.ts承接sourcecomponent→official export binding的closed registry、provenance与漂移检查，并输出provenance.json。实际确定性生成门确认官方export绑定，不手改输出或另造业务schema；schemas.json不是选定官方产物。

源43个components.schemas与官方schemas导出必须逐原对象语义一致，包括原$ref、约束与唯一x-kokoro-credit-unit metadata；registry完整覆盖且仅覆盖这43个source component，unknown component/export/ref与数量、版本、digest漂移失败封闭。Ajv2020 strict＋formats以 #/components/schemas/Name keys注册原schema对象，不重写ref、不注入第二业务schema；coerceTypes/useDefaults/removeAdditional均false。unitannotation仅注册为获准metadata，不参与业务值校验；精确definition_version/display_unit/micros_per_credit继续由owner checker/provenance锁，不因此放宽其他未知keyword/ref。

Root已接收官方probe候选Nest Fastify adapter12.0.1、Hey API0.99.0、Ajv8.20.0、formats3.0.1；这是probe核验事实，不是本仓已安装/生成/兼容完成证据。后继安装前重新核验实际版本/peer/Node24/许可证，固定manifest/lock后再验frozen install/audit/生成重现/类型编译与registry。当前两个scripts、产物、依赖与HTTP源码仍锁，不新开计划中心或第二runtime。

### 后继精确阶段与断言

文件集与目录比较按TECHNICAL_DESIGN R59表，machine/test/checker/generated同一owner一次审查，不复制API到Root/BFF。先验证five-factor正/负控制、已裁定canonical u1最大191/255四字节往返/字节界限、无padding/别名/坏UTF8/NUL/surrogate/重复头、JWT tenant mismatch/时效/audience、partial不降级，再测真实Nest两路注册/严格query/准确wire与全部错误。认证合法控制必须先过，避免所有负例只因404/缺凭据未到校验。

R61独立审的BOM正向补强固定在后继 `test/unit/billing-identity-header.test.ts`（当前不写测试）：参数化分别以tenantId和subjectId为leading U+FEFF合法身份，其他identity保持合法控制；两例都必须成功编码/解码，decoded string保留首个U+FEFF且逐code point等于原值，decoded UTF-8 bytes逐字等于原Buffer（以EF BB BF开头），再次encode所得u1 wire与原wire完全相同。fatal UTF-8且保BOM是同一断言：使用TextDecoder时显式fatal:true、ignoreBOM:true（保留BOM，不是默认剥除），BOM计入191/255 codepoint上限；不得因首字符U+FEFF误拒/strip/normalize。对应输入可为tenant `\uFEFFtenant-a`、subject `\uFEFFsubject-a`，分别参数化，不是只有无BOM ASCII控制。继续保留bad UTF-8拒绝、canonical trailing-bit alias拒绝，以及rawHeaders中x-kokoro-subject/X-Kokoro-Subject混合大小写重复头拒绝，并各自先过合法原wire控制；新增正例不替代这些负例。

真实PG使用现canonical fixture与生产CreditModule/DatabaseModule/RR，覆盖不存在钱包零创建、跨tenant/subject/account、深层损坏/timeout安全错误、所有事实前后相等、事务恢复；source与dist都验。旧target-v1/其他HTTP有效行为由完整C3承接后再删除旧入口，不skip覆盖。两个GET检查点不等于完整24-operation runtime、赠送/admission/settlement/release或收费用户旅程。u1/profile/auth-selection的experimental2.0.2 machine/checker候选已Root771纯门/独立0审；本Phase A对齐provenance后待正式生成与HTTP源码续授，wire未提交发布，不提前激活runtime。

---

## R43-WIN06：本人钱包/ledger API 承接设计门（不改机器事实源）

### R52 当前 cursor 承接（内部修复，未发布 HTTP）

内部 opaque cursor v1 改为 closed 六字段 version/scope/identityDigest/accountId/highWaterSequence/lastSequence，禁止 raw tenantId/subjectId 旧格式双读。identityDigest 仅是分页身份绑定：SHA-256(domain UTF-8 `kokoro.billing.credit-ledger.identity.v1`＋NUL；tenant uint32-BE UTF-8字节长度＋字节；subject同格式长度＋字节)，固定43字符无填充base64url。decode 在任何 SQL 前按受信 context 验 tenant191/subject255 Unicode code point 合法域并重算；非空、无NUL/孤立surrogate，身份不来自query/body/token自报。内部CreditLedgerCursor仍有tenantId/subjectId，不改公开请求/响应/权限或generated类型，不把digest当签名或授权。

2048 raw预算、version=1/scope=credit.ledger、UUID account、规范decimal→BigInt及0<=last<=high<=BIGINT_MAX全部保持；SQL后的本人account/真实boundary绑定与原只读事务不改。v2机器experimental2.0.1/24operations/24paths、HTTP错误/status/no-store/request-id/认证与赠送policy仍锁，尚未正式接线。

Root R51报告74pure59pass15fail、21真实PG20pass1fail（R19容量；R18已过）；当前worker146pure全部pass/0fail/0skip，format/lint/无生成typecheck/build exit0。旧wire负例用新合法基线逐字段实测，legacy raw拒绝有合法控制；subject非法边界改256。integration只collect21/0错误，19资源guard未执行；Root须复验冻结候选，不以纯codec替代HTTP/PG。以下R47/R43是历史阶段，不是当前未决格式。

### R47 历史内部读取候选（未发布 HTTP）

现 CreditService 已增加 getMyAccount(CreditReadContext) 与 listMyLedger(CreditReadContext, CreditLedgerPageInput)，相关内部 bigint/Date 投影从 credit.public 导出；cursor 与 SQL 精确文本 Row 仍是 owner 内部类型，不手写第二 wire DTO。mandatory 第四参 Repository 与现 Module DI 同实例完成候选，原读写方法不改。page 闭集与 limit=50/1..100、cursor 语法/tenant/subject在事务前拒绝；仅通过后进入 readOnlySnapshot，查本人钱包并绑定 account/boundary。缺钱包 null/ledger CREDIT_ACCOUNT_NOT_FOUND，disabled 可读；新增三个内部错误类别沿 D0，不改任何机器 HTTP code/status/权限。

纯 codec 59passed/0failed/0skip；scoped lint/typecheck/build exit0，不是两路 HTTP 验收。冻结 R01–18 integration SHA5c2c1f91未由 worker 执行，Root 后继真实资源与业务断言仍待；R46 Root20失败均停缺方法前置断言，不记作业务已覆盖。v2仍 experimental2.0.1/24 operations/24 paths，YAML/正式生成/认证/Nest HTTP/no-store/request-id/删除v1/BFF消费未改，不加旧 Fastify v2 alias，不推定赠送权限。以下为 R43 D0 阶段记录，本阶段状态以本小节为准，历史正文保持。

任务 R43-WIN06；Billing main 基线 `07fdd0746f99f718c042f0b7bee54e524d2f2a79`，Root 唯一任务表 `docs/task.md` 的 R43 行。当前只有本次四份文档前缀获授权，原五份 dirty 全文保持；source/test/contract/SQL/generated/dependency/runtime/Git/资源均不改。以下是当前设计候选，不是实现、HTTP 发布或测试通过声明。Root 三面文档门通过后才续授 tests RED，再单独授实现；赠送权限的人类裁决未回，本片不新增/推定 gift 授权。

### 机器契约与传输分层

唯一机器源 `contract/openapi/v2/openapi.yaml` 在07fdd074是 experimental 2.0.1、24 operations/24 paths（21个v2业务＋3个健康/观测），SHA256 `f632ddec7b4a8528fcb325ef45f63bd2e37a05319f3505581a9515332cccf16e`。本设计承接现有 `getMyCreditAccount`（GET /v2/billing/me/credit-account）与 `getMyCreditLedger`（GET /v2/billing/me/credit-ledger），不添加operation/path/字段/权限。成功schema分别链接源内 CreditAccountResponse、CreditLedgerResponse/ LedgerEntry/Page；参数使用现 TenantId/Limit/Cursor，schema不在Markdown或手写DTO建立第二可编辑副本。读权限 authenticated-user、idempotency read-only保持，不要求grant key或构建永久GET receipt。

当前真实注册仍v1；R41内存探针21个v2业务404，旧v1账户double200；两operation缺注册，且canonical read methods未具备。第一片只交Credit内部读取能力，不给Fastify补v2别名。后继唯一Nest Guard验证JWT/tenant，形成tenant+本人subject，Controller调Credit用例并映射到正式生成的只读wire类型/运行schema；header/body/cursor不自报身份。正式生产module/生成链当前未接，不声称存在。后继GREEN以CreditService mandatory第四参显式注入现CreditRepository，现credit.module.ts DI复用同实例；不借Effects提供读能力或自行new/optional。旧credit-metering三处构造仅在GREEN机械补参并保持全部原断言，本tests阶段锁定。Browser -> Web同源adapter -> BFF -> Billing；Web不直连Billing或读取owner表。

成功只使用现machine data结构：钱包不返回旧extra属性；ledger使用源定义的items/page而不是旧entries形态。金额与sequence保持十进制string，含 `9007199254740993` 和负delta必须精确；UtcInstant输出ISO Z，request ID仅x-request-id，删除旧body meta.request_id/x-kokoro-request-id属于后继M3，不在本片修改。后继两读使用Cache-Control:no-store；不返回Location/receipt/replayed或比例副本，不为UI列表增加网络usage API。

### 参数、可见性与错误（已有machine状态，不新增wire code）

limit省略=50，整数1..100；cursor省略为第一页，显式空/非string/>2048字符无效，不clamp/coerce坏值。opaque cursor由本owner解析；内部version/scope、受信tenant/subject的identityDigest、account、高水位/末行位置及有界编码按DATA_MODEL当前设计。cursor只是分页输入，不是授权凭据或持久session。身份先验证；语法/tenant/subject不匹配400且不读账务；通过后只找本人钱包，无本人钱包404；其余账户绑定/不存在边界400，不能跨账户读取。

| 后继HTTP状态 | 现machine code/retryable | 语义 |
|---|---|---|
| 200 | 源内成功schema | 钱包存在（含disabled）；已有钱包的空账本为items=[]/next_cursor=null。无账户不临时造零钱包 |
| 400 | billing.invalid_request / false | limit/cursor/未知query或caller account/subject选择非法；foreign cursor统一invalid，不暴露目标存在性 |
| 401 | billing.unauthenticated / false | 缺失/无效用户认证，零账务I/O |
| 403 | billing.forbidden / false | 已认证但tenant/代理边界禁止，零他人查询 |
| 404 | billing.not_found / false | 本人钱包不存在，余额/ledger一致；不可见资源不返回他人账户信息 |
| 500 | billing.internal_error / false | 不变量/非法持久行/响应schema失败，稳定安全消息，不clamp负balance或回退旧表 |
| 503 | billing.dependency_unavailable / true | 数据库不可判定/有界依赖超时，不伪造空钱包或空账本 |

组件内部新增必要的 CREDIT_INVALID_QUERY/CREDIT_INVALID_CURSOR/CREDIT_READ_CORRUPT 类别时统一放现credit.error.ts；缺账户沿 CREDIT_ACCOUNT_NOT_FOUND。它们不成为新增HTTP error code，映射到上述现machine结果；不从数据库message/string判断，不返回SQL、token或cursor payload。无新tenant/actor body字段和grant授权；disabled消费限制、赠送管理员target规则均留其owner后继，不把下方gift候选当本片已定权限。

### 最小RED矩阵与阶段

以下R01–R18为场景组，不预报test数量/执行结果。后继组件测试文件精确为 `test/integration/credit-read.test.ts`，使用现 `createPrismaDatabaseFixture` 自有临时库、生产 CreditService/Repository/TransactionService；原 credit-metering/target-schema 和 frozen72契约测试不改、不替换成double。纯codec单测文件需Root另授，不能以missing import当真RED。

| ID | 必须锁定的断言 |
|---|---|
| R01 | 已有本人钱包返回正确account/status/available/held，两个公开读取方法先有明确定义断言 |
| R02 | 不存在钱包返回null/账户not_found，账户数/时间/generation不变，不ensure |
| R03 | 同subject跨tenant读取只见自身；他tenant钱包存在仍不改变本人不存在结果 |
| R04 | 同tenant不同subject隔离，输入无任意account选择 |
| R05 | disabled钱包只读可见disabled，零消费/入账效果 |
| R06 | 9007199254740993余额/sequence与signed delta保持bigint精确，后继wire String/UTC-Z断言不走Number |
| R07 | ledger无本人钱包为not_found，不返回假empty |
| R08 | 有钱包零journal返回空items/nextCursor=null，零写入 |
| R09 | 相同created_at多条journal以sequence稳定倒序，多页无重复/漏项 |
| R10 | 每行balanceAfter是完整账户历史累计，不是当前page subtotal/当前available/held投影 |
| R11 | limit省略/1/100及0/101/分数/坏类型明确边界，不clamp |
| R12 | 空/超长/非法base64url/UTF8/JSON/非闭集对象/坏version/scope/整数cursor -> invalid，零SQL |
| R13 | cursor tenant/subject与受信context不等 -> invalid，零SQL、不查询他人 |
| R14 | cursor account与本人钱包不等 -> invalid，不按cursor account查账 |
| R15 | 同账户伪造不存在boundary/末行>高水位/非法sequence -> invalid，不以当前max改写cursor |
| R16 | 第一页后真实追加journal，旧cursor高水位固定；再读同cursor稳定，后继新第一页才见新行 |
| R17 | 成功/空/失败读取前后account/grant/hold/allocation/journal/receipt/key/audit/outbox事实与generation/updated_at完全相同；DB READ ONLY拒绝故障注入write |
| R18 | owned账户引用的wrong-tenant journal不能被tenant过滤隐藏；完整累计负数、非法source_kind/source_ref等row必须CREDIT_READ_CORRUPT失败封闭（后继500），不clamp/旧表fallback/伪空页；SUM numeric精度、DB失败/有界timeout安全映射并正常结束事务 |

R41 HTTP assert200实收404是已发生的独立缺注册RED，本D0不再执行它。后继M3另建唯一Nest HTTP RED，覆盖两路注册、401/403/400/404/500/503、exact success/schema/request-id/no-store及旧v1不存在；组件GREEN不能抵消它。赠送/预占/capture/release/usage闭环和真实BFF/Web旅程保持未验，不把这两个read operation冒称全扣费链。

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

## R38 Credit 单位契约：批准目标 2.0.1，未发布 artifact

基线 main `78aa2a3a88107ca1014893b10ae08150bb78ad7a`，当前 machine source contract/openapi/v2/openapi.yaml 仍 2.0.0、SHA256 `eb95b6ddf4c3e611ff3eb065bcb39dad97d47cbf2203f8d6fd8105f17a5b42ad`。本前缀记录 Root 已批准单位 schema metadata，原全文保留；不把下方 admin grant 或 Hey API 候选当当前发布。

唯一新增机器定义位于 components.schemas.CreditMicros：allOf=[现 DecimalInteger ref]，x-kokoro-credit-unit 精确为 {definition_version:1, display_unit:credit, micros_per_credit:"1000000"}。NonNegativeCreditMicros 的 allOf=[CreditMicros ref, 现 NonNegativeDecimal ref]，不重复 metadata；定义只能出现一处，不允许 root/通用 schema/字段/现金或其他 schema 另存尺度。倍率是 string，不接受 number、10^4、空/符号/前导零替代表示或坏 definition_version/display_unit。

目标绑定：
| schema.field | 唯一目标 ref |
|---|---|
| CatalogItem.credit_micros | NonNegativeCreditMicros |
| CreditAccount.available_micros | NonNegativeCreditMicros |
| CreditAccount.held_micros | NonNegativeCreditMicros |
| LedgerEntry.delta_micros | CreditMicros |
| LedgerEntry.balance_after_micros | NonNegativeCreditMicros |
| Subscription.grant_micros | NonNegativeCreditMicros |
| Admission.authorized_micros | NonNegativeCreditMicros |

现金 CatalogItem.amount_minor 仍 NonNegativeDecimal；Checkout/SettlementCreateRequest/RefundCreateRequest/Settlement/Refund 的 amount_minor 仍 PositiveDecimal；LedgerEntry.sequence 仍 NonNegativeDecimal。通用整数 pattern、Credit 有符号/非负语义、nullable/required 与所有 wire 字段不变，无浮点 credit 字段或 response metadata API。目标 info.version=2.0.1、仍 experimental、24 operation/19 path，不增加 admin 第25项、不修改 v1 或生产路由。单位不是现金兑换率或 grant 额度。

发布 pin 为 owner repository + immutable commit + source path + OpenAPI version + full-source SHA256，单位 definition_version=1。只有已提交、校验并生成的 artifact 才允许经 BFF 正式发布方向让 Web 更新；不跟 mutable main，不把旧文档数字当 artifact。生成须从唯一 YAML 提取 extension、携带 provenance并可 --check 重现；当前只存在 Prisma 生成，不声称未安装的 Hey API 会自动输出单位。metadata/digest/版本失败不使用旧比例或默认值。未来倍率变化按 breaking 语义另裁，不并列两种单位。

RED 在现 openapi-v2-target.test.ts：当前源新版/专 schema/单份 metadata/七绑定；完整合法契约控制；缺失/重复尺度、10000、非 string/坏 definition/display、漏七字段绑定、现金/sequence 误绑。负例调用真实 validateV2OpenApi 并核 credit unit 诊断，不以版本或未知 ref 的无关失败充拒绝证据。原安全/operation/nullable/provider/assertions保留；既有目标版本唯一改为2.0.1。纯 RED 与静态门非发布/运行通过；Root 实跑冻结 RED 后再授 YAML/validator/README/current前缀，消费者、正式生成与 v2 runtime 另验。

---

## R38 当前 C1：内部 Credit effect 边界

本提交不修改公开 HTTP 或机器契约，不宣称 v2 runtime 已接线。CreditEffects.capture/release 的公开内部结果仍为 HoldTerminalResult；新增 HoldTerminalMutationResult 的 applied 仅供 Credit 编排审计，不从 credit.public.ts 导出。

source_ref 是原样 opaque 字符串：Unicode code point 长度 1–255，拒绝 NUL/孤立 surrogate，不 trim/normalize。所有终态绑定首次来源；同动作/来源/金额返回原持久结果且零 audit/journal/generation/余额写入，任一身份漂移为 CREDIT_IDEMPOTENCY_CONFLICT。持久终态或 allocation/grant 关系/金额损坏为 CREDIT_HOLD_TERMINAL_CORRUPT；正额 debit 匹配必须 exactly-one，不能先过滤损坏账户/金额。零额/释放不新增零流水。

上述是本地 typed component 的错误，不等于外层 HTTP 已映射。跨 account 的同 source UNIQUE 首因归一、expired batch、正式管理员 target 与 grant API、余额/预占/结算/流水联合用户路径仍待后继。既有机器版本、权限及 micros 整数单位未更改；不发布新的金额单位或前端显示比例 artifact。

# kokoro-billing API 契约策略

## B8-M3 唯一 v2 运行契约承接（2026-09-13）

实施前基线 `19195a13775123d666a586c90fc649116328880c`。目标机器源继续为 `contract/openapi/v2/openapi.yaml`，SHA256 `eb95b6ddf4c3e611ff3eb065bcb39dad97d47cbf2203f8d6fd8105f17a5b42ad`，24 operation/19 path。本阶段不修改它的字段、权限或成功语义；运行切换删除 v1 源、route、validator 分支，不保留双部署。原 M1b/M2b 明确的身份、账务授权、201/202/Location、provider ACK、nullable、永久重放和 GET 最新状态全部为实现断言。

类型和运行 schema 从本地 YAML 确定性生成至 `src/generated/billing-api/`，schema 导出保留 JSON Schema 2020-12 约束和 ref，TS 类型由精确 Hey API 生成器产生。生成器只启用 TypeScript 插件，不创建第二套 SDK/server、可编辑 Zod DTO 或代码反向生成 YAML。运行时 Ajv2020+formats 一次编译；response 不匹配视为内部错误，不能把失败内容照常返回成功。原始 provider body 的签名处理、空/文本 ACK 与 JSON API 分开。依赖比较、版本和退出路线见 TECHNICAL_DESIGN 的 M3。

`contract:check` 最终覆盖生成物漂移、24 operation 的实际 Nest 路由/状态/媒体类型/认证/请求与响应；分别测试无凭据、部分凭据、跨租户、重放及坏 payload，避免只检查 decorator 字符串。源码与 dist HTTP 均从真实 Nest 根装配运行。响应金额为字符串并覆盖 bigint > Number.MAX_SAFE_INTEGER，nullable 必填、时间 Z、未知字段拒绝、无旧 request-id body 字段。

IAM 使用其既有固定版本 artifact，Billing→IAM 验证本人消费授权，IAM 无 Billing 查询依赖。网络在业务事务外，失败/timeout 不产生准入或资金副作用；重放仍先校验身份。Scheduler 的批次使用稳定 occurrence identity，在 Billing HTTP 实现证明同 batch 原子重放；跨仓 scheduler/BFF/Web 更新须 owner committed artifact 后由 Root 分仓授权，M3 不越界修改消费者。

订阅商业 policy 选择仍待用户回复，显式记录于技术方案；这不是新增/改变 HTTP 契约的许可。验收前 v2 experimental 未发布标记不提前改 stable，模拟 provider 验证不记作真实渠道 sandbox 通过。


## B8-M2b 幂等key永久绑定（2026-09-13）

M1b机器artifact仍`47b676f`的v2字节；不改route、请求或状态。依照[技术方案M2b](TECHNICAL_DESIGN.md#b8-m2b-一致性组件与命令键绑定2026-09-13实施设计)，同业务identity同参数换key成功重放时也必须永久绑定新key；以后该key改变identity或参数返回既定409。Binding是内部持久事实，不增加HTTP资源、consumer字段或跨仓依赖；原请求的认证/tenant/subject校验先于结果重放。成功结果、Checkout首次表示/GET最新表示与provider ACK语义保持M1b裁决。Prisma生命周期/审计/outbox本轮只在隔离组件验证，不声称v2已上线。


## B8-M1b 首发机器契约实施决定（2026-09-13）

以已验收M1 `903465059398a4b3a75f68900466fa1003063aae`为基线，执行已批准的首发clean-slate，不再等待历史部署/真实数据回答。当前Fastify/v1未接新Schema，整仓仍禁止部署。
采用目标 `/v2`、OpenAPI 2.0.0语义版本（文档格式沿用OpenAPI 3.1），唯一目标机器源 `contract/openapi/v2/openapi.yaml`；不原位修改已标stable的v1，不新增code-first副本。v2在实现与消费者验收前标experimental/未发布。v1仅服务当前旧源码回归；M3切换时删除v1文件、旧route与旧validator分支，历史字节由Git保存，不发布双版本运行窗口。比较原位改v1（与当前stable声明冲突，淘汰）和另建共享contract/通用operation服务（改变owner且无必要，淘汰），采用本仓版本目录。

### 命令与资源结果裁决

| 能力 | v2路径/结果 | 持久事实与恢复 |
|---|---|---|
| health/ready/metrics | 原无版本路径、原媒体类型；全部响应x-request-id | 不增加业务事实；readiness区分依赖degraded |
| catalog/account/ledger/subscription reads | 原业务资源集合改v2；catalog保留`/v2/commerce/catalog`，其余`/v2/billing/me/...` | typed表示、bounded limit/cursor，去quota壳；subscription观察状态/term与Credit applied分别表达 |
| admission | POST `/v2/internal/billing/admissions` 201；GET `/{admission_id}` 200；capture/release 200 | Billing生成UUID；新准入的IAM个人授权+按次价格+Credit hold同业务编排；capture/release复用原持久授权与受信execution evidence，不再重报价格或付款人；无新operation表 |
| execution event | POST `/v2/internal/billing/execution-events` 202；GET `/{execution_event_id}` 200 | 外部event_id opaque；内部execution_event_id UUID。202只表示inbox+receipt已提交，Location指向该资源；GET暴露received/processed/failed、dead_lettered_at及安全错误，processed不等于execution成功或扣款成功；关联业务结果由admission查询。此版本无取消入口，事件事实不可撤销 |
| Checkout | POST `/v2/billing/checkouts` 201；GET `/{checkout_id}` 200 | 请求只选offer_revision_id，不接收金额/币种/quote_snapshot。Billing冻结报价并创建资源；201不保证provider URL已就绪。准备后的provider创建在事务外，GET提供session_creation_status/payment status/nullable URL/截止。POST相同key重放首次创建表示，后续状态由GET读取，BFF/Web必须支持等待和重试，而非假设立即有URL |
| Settlement | POST `/v2/internal/payment/settlements` 201；GET `/{settlement_id}` 200 | 同步记录付款事实，不承诺自动Credit发放。Billing生成settlement UUID；caller提供provider、provider_account_id、external_payment_ref、amount_minor、currency_code，账户必须经owner校验同tenant/provider；业务identity为tenant+provider+external_payment_ref，账户/金额漂移冲突。无需另造command_id替代已存在外部付款身份；Credit发放仍需可信Checkout/授权。查询分开付款status和nullable fulfillment结果 |
| Refund | POST `/v2/internal/payment/refunds`、`/v2/admin/billing/refunds` 201；GET `/v2/internal/payment/refunds/{refund_id}` 200（同tenant且对应worker/admin权限） | 仅记录已存在渠道退款的追踪事实，不创建外部退款。body settlement_id为Billing UUID，external_ref为真实Refund.id，amount_minor/reason；账户与币种从已验证settlement取得，删除无实现allocation_mode。初始无可信观察则unknown/waiting_provider；可信webhook T1与Credit T2另行恢复。identity为账户+external_ref；GET分开渠道status与credit_effect_status，零delta应用结果可无journal |
| hold expiry | POST `/v2/internal/credit-holds/expire` 200 | 一个有界batch同步提交，响应含batch_id与实际expired_hold_ids。batch_id仍opaque，Scheduler每次occurrence稳定且不同轮次不同；同key/identity replay读永久结果，无需虚构异步operation/GET |
| provider webhook | 分成`/v2/webhooks/payment/stripe`、`/alipay`、`/wechat`，分别机器化签名位置/原始body/ACK | 先验签及账户归属并提交inbox+outbox，再ACK；Stripe 200空body、Alipay 200 text/plain精确success、WeChat 204空body。不得将provider协议强套Billing JSON/202。ACK仅表示已持久接收，重复有效投递仍ACK；持久化失败不得成功ACK |

### 身份、表示与artifact

- Billing本地资源和路径引用UUID；tenant/user/client/invocation/execution/provider/外部event/batch身份仍按owner契约opaque及原明确上限，不用通用UUID管道。不再让caller settlement_id兼任本地主键。
- 新admission在现有受信service认证之外，要求`x-billing-consumption-token`携带原始Billing OAuth user access token（非Bearer前缀，非空且<=16KiB）；仅用于调用IAM固定artifact的verifyBillingAuthorization，不记日志/receipt/SQL或透传错误。IAM返回tenant/user必须与调用tenant及本次绑定一致，payer固定该user本人钱包。body删除payer_ref；必须保留既有对象形态billing_subject={kind,ref}作为使用归因，kind闭集user/project/organization/service，ref为1–255字符opaque string；持久化到billing_subject_kind/ref，不得选择钱包。kind=user时ref必须等于验证所得user_id，其余类型仅作调用服务负责的归因，不因此授予访问该资源的权限。没有token、scope不足或IAM故障拒绝新准入，不猜免费/组织钱包；同scope重放仍校验调用主体，capture/release根据原admission所有权及受信执行身份恢复，不要求另一个当前用户代付。
- 现有service/admin/user角色许可语义不扩大。任意tenant/service/subject header只是已认证代理协议中的选择或断言，必须验证允许的service/tenant/subject代理边界；不把明文header本身当认证。个人消费scope固定billing:credit.consume，IAM不调用Billing，decision_ref不作凭据。
- 所有Billing JSON成功为data，分页metadata仅有业务分页语义；错误为error.code/message/retryable及受限details；request ID只在x-request-id，删除旧header/body meta.request_id。逐operation声明错误状态/可重试规则，未知异常只返回稳定安全消息。201/202声明Location；查询权限与原写入资源tenant/subject匹配，不可见统一404。
- UTC instant RFC3339且以Z结束，现金minor与Credit micros均十进制整数string；有符号journal允许负号，余额非负；现金currency_code大写三字母，不以CRD冒充币种。显式nullable而非遗漏猜测；对象默认拒绝未知字段，provider原始payload及具名versioned执行证据允许受限扩展。
- artifact采用现有Git固定对象路径，不引入第二套SDK发布服务：consumer记录repository、完整commit、source_path、info.version、sha256；从已提交owner artifact生成consumer本地只读类型，并校验摘要。M1b不编造尚未产生的commit/tag、不发布远程；最终consumer pin由M5完成。
- M1b只落目标机器源、其静态/语义反例门及治理文档，不冒称runtime parity。当前`pnpm contract:check`保持v1真实route校验并显式增加v2 target检查，分别报告；M3删旧分支后改成唯一v2 runtime parity。字段schema只在YAML可编辑，设计文档不复制第二套对象。

官方协议依据于2026-09-13重新核验：[Stripe webhook](https://docs.stripe.com/webhooks?lang=node)、[支付宝异步通知](https://help.alipay.com/support/help_detail.htm?help_id=491081)、[微信JSAPI通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791861)。它们只证明签名/ACK等渠道协议要求，不证明本仓sandbox已通过；幂等与本地事务取舍由本仓设计/测试负责。


## B8-M1 canonical 模型切片实施决定（2026-09-13）

本轮仅落实已审R2/R3/D2目标canonical与只读Prisma，字段/约束唯一设计见[DATA_MODEL的M1决定](DATA_MODEL.md#b8-m1-canonical-模型切片实施决定2026-09-13)。当前v1机器合同及Fastify/pg仍是旧运行时；新Schema是完整切换的非部署中间态，不代表旧HTTP已适配，也不改HTTP权限、字段、状态或消费者。完整业务切换仍须目标机器契约与全部writer/consumer同时闭合。首发无真实数据不授权清库；禁止兼容表/view/第二canonical。本次授权仅离线Schema/生成/约束验证，不把局部文档门当作生产重写放行。



> **B8-S4 局部实施门（2026-09-12，基线 ada75b2）**：当前扣减链路的 usage–hold 绑定先在现有唯一 writer 落地；
> canonical `entitlement_usage_event.credit_hold_id VARCHAR(36) NULL UNIQUE` 匹配当前 hold 类型，派生 event 使用独立 randomUUID。
> 同事务验证 scope/state、持久绑定及重放；HTTP 17 操作和内部方法签名不变，无新 API、FK、迁移或兼容分支。
> 当前 pg 整体事务保持，Prisma 全事务组承接仍待 M3；目标 `billing_usage_event.id/credit_hold_id UUID` 不等于当前类型已切换。
> 放置/唯一 writer/删除项/测试门详见唯一任务板 B8-S4；仅对该 P0 放行，不代替完整目标三设计门。
> S4-R2：内部 hold key/capture source/capture 与 release key 使用 Billing admission UUID；255 字符外部 invocation_id 原样保存，原 receipt 身份/digest 仍权威，不收紧 wire 上限或保留拼接 fallback。
> ensure 仅无锁校验快照和唯一绑定记录，消费权限由 settle 持锁后重验；旧全 Credit 锁图重排仍留整体事务组切换。

> **2026-09-12 当前首发裁决**：用户确认尚无真实账务数据、服务未开放；按首发clean-slate目标实施，历史数据/已发布major的待确认不再作为本轮前置。
> 不重置共享数据库、不构造历史兼容。M2a仅提前实现D1已审定且不依赖表/API的Prisma事务组件（见任务板），本仓SQL/HTTP/生产writer保持当前态；完整目标Schema与付款授权门仍按业务切片闭合。


B5/B6 仅新增离线 catalog/Prisma 生成和隔离承接验收命令，不变更 17 个 HTTP operation、wire schema、身份、状态或消费者；OpenAPI 保持不变。

## 2026-09-08 当前契约与目标差异

下文是当前OpenAPI/运行时语义，并不表示已符合最新Root API手册。B3文档及B4安装保护切片不改任何HTTP字段、路径、
身份、状态码、cursor、digest或响应；17个operation的当前contract SHA保持不变。目标与实施顺序见
[ADR-0003](ADR/0003-nestjs-prisma-sql-first-alignment.md) 和 [任务板](IMPLEMENTATION_PLAN.md)。

后续contract切片必须处理：

1. request ID只通过`x-request-id`响应header传输；删除当前`x-kokoro-request-id`与`meta.request_id`，不建header alias。
2. ledger instant改RFC3339 UTC；金额/credit仍以当前十进制wire及显式精度规则表达，不把Prisma bigint直接送JSON。
3. feature typed error与HTTP mapper分离；逐码确定status/retryable/safe message，不按`Error.message`前缀或“全部409可重试”推断。
4. 补全17个operation的request/response/error语义，说明202已提交的接受事实与后续业务终态，以及真实存在的查询/取消能力；
   不为凑契约编造endpoint。design-first YAML维持唯一机器来源，生成validator或全量semantic parity须先验证。
5. 当前契约标stable且ADR-0002要求major breaking。上述wire变更属于breaking，必须先核验实际发布/消费者，再单独记录
   clean-slate owner/consumer切换裁决；此轮不擅自将stable v1原位改写，不预建双协议或长期兼容窗口。

这些目标尚未进入机器契约，完整API切换门未通过。B4只操作离线安装入口，无传输契约变更，可按局部设计实施。

Canonical machine-readable source：[`../contract/openapi/v1/openapi.yaml`](../contract/openapi/v1/openapi.yaml)。本文件解释
owner、身份、幂等、错误与 consumer 规则，不复制字段级 Schema。Contract 的 version/generation/breaking/provenance 见
[`../contract/README.md`](../contract/README.md)。

## B8-R3 定价与一致性支持收敛（2026-09-12目标）

- Receipt/outbox物理合并不让调用方传namespace、表名、lease token或Prisma参数。保持受信tenant、命令identity、双唯一域、
  同digest重放与异digest冲突；持久结果而非Redis命中决定成功。历史API/digest仅在明确major切片切换，不因内部合表偷偷变化。
- 目标销售profile固定为feature按次Credit价格；admission请求不接受调用者报售价或token数决定用户扣款。
  feature来自已验证请求，选择已发布完整价目表；meter_kind/requested_model_tier保留为请求身份/审计而非隐式price key。
  显式零价返回included，未配置price返回稳定price_unavailable，不默认免费；current payg枚举不是已实现的后付费承诺，目标不保留该空能力。
- 新major的admission资源应明确pricing_revision_id、feature_price_id、authorized_micros和pricing_snapshot_digest，Credit单位明确为micros，
  不以currency_code=CRD冒充现金币种；digest由Billing生成和校验，不作为caller可指定字段。capture沿校验后的原授权金额，历史price变更不重报价。具体request/response/error必须写入唯一机器契约，不能继续泛型V1Accepted省略字段。
- 价格发布是完整非空snapshot，revision为发布序列，以effective_from再revision确定生效优先级；同一时刻高revision胜，缺feature不回落旧版本。
  不在本轮为了内部seed/admin能力新增公开HTTP操作。需要发布入口时由Metering owner定义权限、幂等和机器契约。
- 删除未被生产调用的token报价接口仅指本仓内部service/factory，不声称它们曾是HTTP API；无成本计费新能力。
  quota_micros/quota_period目标从summary及Web schema/UI/fixture删除，BFF透传/映射与固定Billing artifact一起更新；赠送grant与余额查询仍保留。
- 当前本地尚未发现BFF/Web/Agent/System调用Billing admission HTTP；这是检索证据，不是仓外无人调用或无需契约的证明。
  Provider inbox任务、Refund/Subscription效果任务与纯通知分开；202、outbox completed及Credit applied含义各自明确，未知receiver不由空handler确认。

付款授权仍是R4强制门：当前body billing_subject/payer_ref不得直接等同受信付款账户。必须定义允许的issuer/委托scope、tenant/付款subject/
invocation绑定与验证入口，且不能要求调用方上报任意account ID便扣款。使用主体可作归因，但账户选择须来自验证后的授权上下文。
该契约尚未机器化；不以此次合表/定价设计宣布完整业务门通过。

本节与R2内部模型决定一起进入下一机器契约/完整canonical阶段；当前stable v1、17条操作及真实消费者保持原样。

## B8-R2 模型收敛与幂等约定（目标，机器契约未变）

- Prisma事务、SQL-first结构管理和Redis辅助去重是内部工程选择，不新增HTTP事务参数、Redis锁token或ORM类型。
  客户端仍使用明确的幂等身份；同identity同digest读原持久结果，改变参数为冲突，不能因Redis TTL过期获得再次发放资格。
- 目标把acquisition/fulfillment合成永久CreditFulfillment，业务结果保留fulfillmentId/grantId/journalId语义；
  当前机器契约未定义独立acquisition资源，本轮不新增其endpoint或对外暴露acquisition_id。
  这不证明仓外没有历史事件/数据引用；真实ID迁移和breaking仍经D2门，不原位改变stable v1。
- 当前一次性付款/单item订阅profile每个来源只发一次、一份grant、一个program。program是不可变授权的一部分，
  同source换program等授权参数为冲突；换幂等key但identity/digest相同仍重放原结果，不再次发放。
  未来多program/multi-item需独立profile与契约设计，不能静默扩大journal来源语义。
- 退款保留独立credit_fulfillment_id/credit_grant_id与每笔冲正结果；零delta已应用可没有journal。
  订阅资格/等待/term与Credit已发放结果分别展示，T1 accepted不等于T2 applied。

本节不修改现有17条operation或生成artifact；核验命令只证明当前契约仍有效，不证明新模型或major已实施。

## B8-D1事务目标与B8-D2契约边界（2026-09-10）

B8-D1提供内部模块/事务设计，数据映射由B8-R2继续修订；SQL/OpenAPI仍是当前v1字节；它不批准任何HTTP breaking实施。
所有带幂等的业务变更继续遵守trusted tenant/actor、key+identity+versioned digest、成功durable result同提交；
内部Prisma UUID/BigInt/JSON/错误不得泄漏为未经定义的wire形状，本文下方v1既有字段与行为仍有效。

| 身份类别 | 目标数据库语义 | 当前契约影响 |
|---|---|---|
| Billing自己产生的checkout/account/grant/hold/admission/usage/receipt等资源 | 应用UUID主键与本地引用 | 部分v1 schema未声明UUID；客户端accepted input先逐项审核，不原位收窄 |
| caller settlement_id | 当前既是PK也是command identity/result/refund定位 | 必须决定生成权、外部业务identity命名、digest版本与major切换；未决定前不改字段 |
| provider_event_id（内部）与event_id（外部） | 前者UUID、后者opaque；execution同理新增内部UUID | 不能让外部provider/Agent为了内部PK格式更改其事件ID |
| tenant/subject/operator/invocation/execution/provider reference/batch_id | 外部opaque或命令identity | 保留定义与长度，不加通用UUID管道；batch/command identity不是资源PK |
| cursor | opaque、绑定tenant/resource及稳定排序 | 不复用数据库ID当无签名跨scope cursor |

B8-D2必须从以下两个完整方案作一次决定，不实现长期双轨：
1. 推荐新major owner contract，一次切换全部真实消费者与配置，移除v1入口/旧header/envelope；Billing拥有内部资源UUID，
   调用者提供独立业务identity，receipt/digest与refund lookup均明确。先证明当前部署/真实数据状态，再决定仅fresh install还是独立数据演进ADR。
2. 保持已发布v1资源identity，仅进行无wire变化的内部模型映射，同时另列真正major发布目标；如果采用此方案必须明确为何仍满足既定最终规范，
   不能把它当隐藏alias/fallback或以“兼容”为由取消目标中的request-id/UTC等收敛。当前未采用此方案。

已询问线上账务数据/仓外调用方状态，尚未收到事实回答；空GitHub release/tag列表不能证明未部署。Root不擅自选择清库、原位改stable v1或造假消费者不存在。
这里的major切换决定必须单独确认；内部目录、writer、事务失败策略由Root按既定规范裁决，无需把普通命名问题交给用户。

### HTTP接受事实与Credit效果：必须闭环的契约项

当前settlement accept、internal refund、admin refund三入口只返回202接受事实；Recorded outbox没有仓内生产消费者，独立webhook的处理不能充当该HTTP链保证。
B8-D2须明确每入口到底承诺fact-only还是durable后续effect，以及消费者能如何知道结果；不能仅改202文案制造实现已完成的印象。
设计优先采用同一owner幂等effect能力：已具备可信checkout/program/subject快照时可在同事务完成，确需异步则注册具名handler、bounded retry/dead-letter与真实终态查询。
缺失关联不能按payment金额猜测Credit，也不增加向provider主动退款的未请求功能。若fact-only确是业务需求，则移除“待处理”的虚假承诺，
对应通知事件需明确真实接收者或随切片删除无人消费的路径；不设置空handler直接ack。

本轮机器契约/Schema验证仍证明当前v1，不证明上述目标已生成或已兼容。完整重写门未通过，不能以B8-D1内部审查替代B8-D2。

## Visibility 与版本

- Owner：`kokoro-billing`。
- Visibility：全部 operation 为 `internal-owner`。Provider webhook 虽接收外部 provider 流量，仍是 Billing 的受控 ingress，
  不是 Kokoro Developer Product API。
- Stability：当前 operation 标为 `stable`，wire document `info.version=1.0.0`。
- 非探针路径必须位于 `/v1/**`；`/healthz`、`/readyz`、`/metrics` 是内部运行端点。
- Root Developer API 门户只发布 BFF 的 `public` contract，不发布本契约。

## Operation 与身份

| Operation | 当前 caller / permission | Idempotency metadata |
|---|---|---|
| `GET /healthz`、`GET /readyz`、`GET /metrics` | network policy 下的 probe/scraper；应用层无 auth | `inherent` |
| `GET /v1/commerce/catalog` | IAM user，或完整 `web-bff` service-auth | `read-only` |
| `GET /v1/billing/me/credit-account` | IAM user JWT + matching tenant | `read-only` |
| `GET /v1/billing/me/credit-ledger` | IAM user JWT + matching tenant | `read-only` |
| `GET /v1/billing/me/subscriptions` | IAM user JWT + matching tenant | `read-only` |
| `POST /v1/billing/checkout` | IAM user，或含 subject 的完整 `web-bff` service-auth | required header + checkout fact/hash |
| `POST /v1/internal/entitlement/admissions` | `agent`、`model`、`studio` | required + durable Billing receipt |
| `POST .../admissions/{admissionId}/capture` | `agent`、`model`、`studio` | required + durable Billing receipt |
| `POST .../admissions/{admissionId}/release` | `agent`、`model`、`studio` | required + durable Billing receipt |
| `POST /v1/internal/billing/execution-events` | `agent`、`model`、`studio` | required；event ID identity + PostgreSQL receipt/digest |
| `POST /v1/internal/payment/settlements/accept` | 当前实现允许 `payment-worker` 或 `scheduler` | required；`settlement_id` identity + PostgreSQL receipt/digest |
| `POST /v1/internal/payment/refunds/accept` | `payment-worker` | required + reversal fact/receipt |
| `POST /v1/internal/commands/expire-credit-holds` | `scheduler` | required；`batch_id` identity + PostgreSQL receipt/digest |
| `POST /v1/webhooks/payment/{provider}` | provider-specific signature + account-to-tenant mapping | provider + external event ID |
| `POST /v1/admin/billing/refunds` | trusted admin proxy + role `billing.admin` | required + reversal fact/receipt |

`X-Kokoro-Tenant-Id` 是受信 tenant context，不从 JSON、query、provider payload、account ID 或 runtime namespace 推导。

## Storefront 的两条互斥身份路径

用户路径使用 IAM RS256 JWT；JWT 的 `tenant_id` 必须与 `X-Kokoro-Tenant-Id` 相同，subject 来自 `sub`。BFF 路径同时要求：

```text
X-Kokoro-Service: web-bff
X-Kokoro-Internal-Secret: TOKEN
Authorization: Bearer TOKEN
X-Kokoro-Tenant-Id: TENANT
X-Kokoro-Subject: SUBJECT    # checkout 必需；catalog 可省略
```

一旦请求包含内部 marker，Billing 就锁定 service-auth 分支；失败不会降级为用户 JWT。BFF alternative 不适用于
`/v1/billing/me/*`。

## Internal、admin 与 webhook

- Internal service 必须携带 registered `X-Kokoro-Service`、`X-Kokoro-Internal-Secret` 与 tenant context；每条 route 再做
  allow-list。
- Admin 必须由 `X-Kokoro-Service: admin`、独立 proxy secret、operator identity 和精确 role `billing.admin` 组成。
- Provider webhook 在持久化前做 provider-specific raw-body signature 验证。生产 provider 集合与签名位置固定为：

  | Provider | Content type / signature source |
  |---|---|
  | `stripe` | raw JSON + `Stripe-Signature` header |
  | `alipay` | `application/x-www-form-urlencoded` body 中的 `sign` 与 `sign_type=RSA2`；不读 query/header alias |
  | `wechat` | raw JSON + `Wechatpay-Timestamp`、`Wechatpay-Nonce`、`Wechatpay-Signature` headers |

  OpenAPI 标准 security scheme 不能表达 body field authentication，因此 Alipay 的位置由必填 `AlipayWebhookForm` 与
  `x-kokoro-provider-signatures` 共同约束；contract 不声明伪造的 query scheme。生产 `jwks` 模式从 provider account mapping
  解析 tenant；payload tenant 若存在必须一致。
- Execution event 不携带第二套 caller-selected signature 字段；信任来自已认证 service context。

## Envelope、命名与数值

v1 成功和失败分别为：

```json
{"data": {}, "meta": {"request_id": "req_TARGET"}}
```

```json
{"error": {"code": "billing.invalid_request", "message": "...", "retryable": false, "details": {}}, "meta": {"request_id": "req_TARGET"}}
```

外部 JSON 使用 snake_case。金额与 credit 通过 decimal string 传输，进入 application 前检查 JavaScript safe integer 范围；
数据库使用整数。当前例外是 ledger `created_at` 使用 epoch milliseconds，见“缺口”。

## 幂等、并发与重试

- 声明 `required` 的 operation 要求 8–128 个 printable ASCII 字符的 `Idempotency-Key`。
- 同一 tenant/command/key + 同一规范化 payload 返回原事实；同 key 不同 identity/payload 返回
  `billing.idempotency_conflict`（409）。
- Admission command receipt 额外包含 API surface。Authorize、capture、release、execution-event 的唯一业务 identity 分别是
  `invocation_id`、path `admissionId`、path `admissionId`、`event_id`；capture/release 在任何 admission 终态短路前先核对 receipt。
  Capture digest 覆盖 accepted receipt 全部字段；release digest 覆盖 `invocation_id`、`reason` 与可选 `service_receipt`；execution
  digest 覆盖完整 event envelope。它们都保存 HTTP `Idempotency-Key` 和持久化 result。
- Checkout 直接以 `payment_checkout` 作为 tenant/key durable fact。带版本的 digest 覆盖 subject、offer revision、金额、currency 与
  完整 quote snapshot；object key 在所有深度排序、array 顺序保留、非 JSON 值拒绝。Existing key 的 digest/replay 在读取当前 catalog
  之前裁决，因此首次成功后的 offer disabled 不使原命令失去可重放性。
- Settlement command name 是 `payment.settlement.accept`，identity 是 `settlement_id`。Digest 覆盖版本化 command、provider、
  external payment reference、amount、currency 及可选 provider event/checkout identity；成功结果持久化后按 key 或 identity 重放。
- Expiry command name 是 `entitlement.credit-holds.expire`，identity 是 `batch_id`。Digest 覆盖版本化 command、batch 与规范化后的
  `limit`（缺省值 100）；成功结果保存精确 `expired_hold_ids`，重放不再次扫描。
- Refund command name 是 `PaymentReversal`，业务 identity 是 provider + external reversal reference；versioned digest 覆盖 settlement、
  provider/external ref、amount、reason 与可信 admin operator。Receipt claim 使用 `ON CONFLICT` 后锁定并比较，独立连接的等价并发
  重放同一 reversal，payload drift 返回 409。
- 对具备业务 identity 的 command，同 identity 换 key 仍读取同一 receipt；同 key 换 identity/payload 必须 409。
- Redis hint 只写 tenant/route/key 的短 TTL presence marker，不接收或比较请求 body/digest，也不返回 replay/conflict 裁决。
  Redis miss、timeout、坏记录和 JSON 字段顺序不改变结果；API/expiry 在 Redis 丢失时继续 PostgreSQL path，`/readyz` 报告
  `redis=degraded`。规范化 command 与 PostgreSQL receipt/owner fact 是唯一裁决。
- Receipt claim/effect/result 在单一 PostgreSQL transaction 内完成，当前不承诺 processing lease/reclaim。可见历史
  `processing|unknown` 返回 `billing.command_unknown`，`failed` 返回 `billing.command_failed`。
- Provider webhook 不要求 caller 生成 Idempotency-Key，以签名后的稳定 external event ID 去重。
- 只有已知 retryable 结果可使用原 key 重试；不确定结果先查询/reconcile，不创建新 key。

## 分页

Catalog、credit ledger、subscription 使用 `limit`（1–100）与 opaque `cursor`。Cursor 绑定 resource scope 和 tenant；ledger
还绑定 subject 及稳定排序键。损坏、跨 tenant/subject 或非法 cursor 返回 `billing.invalid_cursor`。Consumer 不解析 cursor，
只回传 `next_cursor`。

## 错误策略

稳定错误 namespace 为 `billing.*`。当前重要类别：

| 类别 | 示例 | HTTP/重试语义 |
|---|---|---|
| 身份/权限 | `billing.unauthorized`、`billing.forbidden`、`billing.service_auth_failed` | 401/403；修正身份，不自动重试 |
| 输入/协议 | `billing.invalid_request`、`billing.idempotency_required`、`billing.invalid_cursor` | 400；修正请求 |
| 额度 | `billing.insufficient_credit` | 402；业务终态 |
| 冲突/未知 | `billing.idempotency_conflict`、`billing.command_failed`、`billing.command_unknown` | 409；按原 key 查询/重放/对账 |
| 依赖/配置 | `billing.dependencies_not_ready`、`billing.*_not_configured` | 503；受控退避 |
| 内部错误 | `billing.internal_error` | 500；包括 durable result 不变量损坏；不泄漏内部 code/provider/SQL/stack |

Transport 会补齐 `retryable`、`details` 与 `meta.request_id`；consumer 只依赖稳定 code，不解析 message。

## Contract-first 变更

```text
Billing OpenAPI source
  -> contract governance/route/shape checks
  -> implementation + transport/contract tests
  -> versioned artifact (commit/tag + digest)
  -> pinned consumer update
  -> integration/smoke
```

不手改 generated artifact，不从 Root 或 consumer 复制第二份 editable DTO。

## 当前 contract 缺口

- Capture/release request body、execution-event 409、settlement/expiry request body 与 Redis readiness 状态已纳入 checker；其他
  mutation 仍有不完整 request body、精确 response 或错误集合，部分 response 使用 generic schema。
- 当前 checker 不执行 historical OpenAPI breaking diff，也没有机器 provenance manifest/artifact publish job。
- Ledger `created_at` 是 epoch milliseconds，不符合平台 RFC 3339 UTC 目标。
- Route parity 不能证明运行时 Zod 与 OpenAPI 字段语义完全一致；在补齐 shape 前需人工逐 route review。


## B7b 输入边界收窄记录（2026-09-10）

本切片未改变canonical OpenAPI字段/路由/版本。内部持久化quote credit只接受string|number并继续既有整数范围校验；
execution receipt的provider_operation_ref若存在且非null，须为string，否则处理时报billing.execution_receipt_invalid并回滚capture。
null/缺省保持event fallback。webhook先使用provider解析结果，仅对缺省结果的raw ID/type fallback做string校验；
非法对象/数组/布尔/数字fallback返回既有400 billing.provider_payload_invalid，null/缺省保持既有空ID/unknown。
这是显式记录的输入收窄，不宣称错误输入行为完全不变；完整机器契约/消费者切换仍归B9。

## B8-S0当前Stripe回调的paid-only准入修复

只改变既有Stripe Checkout事件的内部归一化：明确payment模式且payment_status=paid、无subscription引用才进入一次性付款效果；
其他事件保持原type交当前processor ignored，不以完成Checkout页面推断资金到账。缺省mode/status的旧合成fixture此前被错误放行，现收窄，不冒称非法输入行为完全不变。
HTTP路径/身份/raw body SDK验签/inbox去重/响应状态与schema不改；迟到的async成功事件仍可处理。当前金额严格正数的profile不自动给no_payment_required发放Credit。
该局部修复沿用当前机器契约，并不批准stable v1的UUID/header/envelope/版本切换；订阅及免费权益政策仍有未决项。


## B8-D2a Checkout内部结果与待决wire边界

本轮不改stable v1机器源。目标内部Checkout结果为具名联合：pending（持久已接受/等待恢复）、ready（已有session identity；URL可能因provider终态为空）、
failed（明确且持久session_had_unknown及本SDK调用uncertainty均为false的未执行错误）、review_required（未知结果超预算或身份冲突）。这是owner内部业务结果，不是另写一份wire DTO/schema。
同tenant/subject/key只能指向一个固定Checkout；重试同请求可查询当前状态，不能生成第二session/provider key；不同digest依旧conflict。
prepare准入截止quote_expires_at与provider_session_expires_at必须在最终机器contract分别说明，不将当前expires_at原位改义。

目标调用者应能够取得已持久接受的Checkout identity并查询后续状态，不能以无ID的通用500或201+缺URL假装可用付款页；
exact status code、Location、查询operation、稳定错误码与重放语义在同一新major owner contract一次裁决，消费者随后更新并移除旧入口。
本设计不预建新HTTP路径/双协议，不把尚不存在的查询或管理员修复接口写成当前能力。提供这些能力是B8/B9待交付项而不是删除目标。
UI取消跳转/付款成功跳转仅是导航，不能作为支付、退款或取消平台会话的权威事实。

Checkout只读导入Payment核心账户公开能力，所有tenant/actor从受信上下文取得；任何account/provider_environment/checkout_session_mode/session绑定字段均不从用户body自报后直接采信；环境test/live和会话payment/subscription是两个独立维度。
Provider verified事件是独立确认通道，但仍需本仓snapshot金额/币种/身份一致和幂等Credit效果；不能把create ready或subscription active等同已收款。

尚待用户事实/major确认的范围仍如B8-D2段：现有账务数据、仓外v1调用者、数据演进方式与整体breaking契约。当前17operation/SQL原样验证不证明未来状态机/Schema通过。

## B8-D2c退款语义与终态边界（内部设计R2已审查，机器v1不变）

D2b所测三个accept入口的成功receipt仅表示记录命令完成，不证明Stripe创建退款、渠道成功或Credit冲正成功。
新major必须分别描述“发起商户退款命令”“接受受信退款观察”“查询退款及Credit效果”，不把同一202同时解释为三种完成。
内部query结果包含refund identity、准确provider观察状态、独立credit_effect_status与review标记；发生渠道失败回流时可同时显示provider failed和credit applied/review，不掩盖已有账务。
命令receipt重放仍返回原record接受结果，当前状态从受信owner query获得；不要通过每次重放改写receipt来假装它是最新状态查询。
RefundRecord/RefundQuery为内部业务input/result，不在contract另存可编辑Application DTO；机器schema与新HTTP status/Location/分页/错误在major切片统一发布和验证。

Stripe退款身份是执行账户scope下Refund.id；Event.id只表示观察投递，不能当退款身份。charge/PI/币种须与已持久付款关联，tenant/actor/账户授权来自受信上下文。
metadata.checkout不是授权与唯一付款选择条件。missing identity/amount、累计charge amount、未知status不得归一化成功；金额只接受该provider定义的integer minor单位，不使用共享decimal major转换器。
当前line_specific缺选择器/算法，不保留“接受后忽略”的目标；其确切行模型、订阅退款与商户发起退款策略仍需业务/major门。
record root与provider observation effect分离：无已验证渠道证据的record返回接受结果，但查询明确provider unknown、credit waiting_provider，不enqueue扣账；provider观察加入ProviderEvents同事务，不claim第二record receipt。
Stripe JSON number金额先Number.isSafeInteger且>0后转BigInt；unsafe/fraction/string/object/null不以隐式转换或累计金额补齐。
单grant比例冲正沿既有规则，结果允许0 micros（如1 credit拆3次退款），零delta在身份/策略检查通过且无review时为已应用结果；此前本链冲正造成exhausted不阻断，expired/revoked仍review。查询可无journal ID，不能宣称账本漏写。
用户跳转/管理员点击/返回accepted均非渠道成功证据；provider succeeded之后也可能failed，查询与告警应展示需复核而不是自动补发或隐藏历史冲正。

实施前必须补齐两个refund的机器request/response/error shape、账户/tenant权限、幂等与状态查询、消费者artifact更新；切换时删除被替代旧v1入口与reason前缀含义，不提供长期双协议。
尚未获得真实数据/仓外消费者事实确认，本节不改变当前17operation或API版本，不把缺失的终态查询写成当前可调用功能。

## B8-D2d订阅契约目标（机制R2已审查，商业发放规则待确认）

当前Subscription parser输出的grantCredits是实现中的猜测，不作为目标provider contract；目标区分生命周期观察、Invoice/line结清证据和Credit资格/应用结果。
Invoice.paid不能被描述成新增银行卡实收；实际Payment资金来源与结清方式分别保留。普通付费周期发放、试用/零额/余额抵扣/手工结清等资格尚待业务确认，当前v1不静默改变这些含义。

Subscription绑定必须来自受信Checkout和执行账户关联；删除以metadata.teamId/planId选择subject/最新offer的目标路径，不增加teamId/subjectId旧新双读。
现代items周期与Invoice服务line身份必须完整，分页/多item歧义显式待复核；period.id、invoice/line ID、subscription.id和event delivery ID不可混用。
当前GET /v1/billing/me/subscriptions返回的subscription_id实为term.id；新major需明确资源身份及生命周期/账单/发放三维状态，owner contract与BFF消费者同切片更新，不原位变义。
金额JSON number先safe-integer校验、时间戳转换后须有效UTC；不同金额字段的零/负数规则按Invoice实际语义，不用Refund正数规则一刀切。

record观察接受不表示Credit已经可用，query显式区分waiting_evidence/waiting_period_start/pending/applied/review与队列失败；未开始的服务期不得提前承诺available。
同period相同授权成功后，过期/取消/下架不破坏历史结果重放；query展示当前状态，不能反过来重写receipt或再发一次额度。
同一invoice服务行与同一订阅item周期有两道唯一性，避免事件重发或另开invoice重新发放；变更计划/补差价/宽限/试用赠送/退款关联需明确业务契约，不用active状态代替。
完整机器request/response/error、分页、状态转换与对外授权只在major门统一落地。本轮机器17operation/版本未改，待批准policy不得当默认配置启用生产发放。

D2d状态澄清：合格但DB now<start时明确waiting_period_start，窗口内pending，首次过期review；到期同事务转pending并应用，失败不虚报余额可用。
分页/网络暂态尚未取得完整观察时inbox继续有界重试，耗尽dead-letter；已完整但未结清的waiting_evidence由后续Invoice事件或现payment worker持久due扫描补查，不依赖一定有下一条webhook。
自动补查耗尽展示review与原因，不伪造invoice failed；政策未批准不轮询或发放。资金证据区分InvoicePayment分配额/账户scope稳定引用与可空Payment settlement，不以PI总额或纯事件名证明结清方式。


## B8-D3 对账运维报告目标（非现行HTTP接口）

保持当前v1 OpenAPI17操作和旧reconcile HTTP404；目标为tenant必填的一次性owner CLI，schema-first机器报告另放本仓contract/reconciliation/report.schema.json（本轮尚未创建），不向BFF/Web发布新的网络入口或假设已有Scheduler client。

目标JSON：schema_version、run_id、tenant_id、as_of、finished_at、status（ok/drift/incomplete/failed）、complete、limits、checks、error_codes。checks逐项含code、owner、category、status、examined、finding_count、pending_count、items、items_truncated、scan_complete；item包含tenant与具名resource refs和适用generation/digest，不包含provider payload/URL/token/自由异常。数值溢出风险字段按十进制字符串、时间UTC，与现有wire约定一致。

required checks全部完成且无异常才ok；扫描未覆盖完即incomplete，即使已有drift也不宣称完整。完整但有差异为drift；权限/Schema/解析等运行错误failed。样本展示截断不等于扫描截断；不接受跨run cursor续接成一致snapshot。退出码0=完整ok、2=完整drift、3=incomplete、1=failed。正常pending只在owner有效恢复证据/期限内计数，不宣称付款或发放已经完成。

报告只观察、不重试、不repair。受控重试仍属于各owner已有/目标的审计命令，须检查tenant/权限/原命令identity/当前generation与状态；本CLI不新增通用force/retry-all入口。Schema/CLI/周期触发/角色与contract测试均仍待实施。
