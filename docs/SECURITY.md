# kokoro-billing 安全边界

## 1. 资产与威胁面

高价值资产包括 tenant 隔离、payment/provider identity、checkout quote、credit balance、journal、receipt、provider payload、
operator audit 与签名/服务凭据。主要风险是跨 tenant 访问、伪造内部身份、webhook 重放或错绑 tenant、幂等键碰撞、金额篡改、
secret 泄漏、直接数据库改账和 provider/queue 滥用。

## 2. 信任边界

```text
Browser -> Web same-origin adapter -> BFF -> Billing internal-owner API
Agent/Model/Studio -----------------------> admission/execution routes
Payment worker / Scheduler --------------> allow-listed internal routes
Admin gateway ---------------------------> admin refund route
Payment providers -----------------------> signed webhook ingress
Billing ---------------------------------> PostgreSQL / Redis / Stripe
```

Browser 不直连 internal/admin/webhook route。BFF、Scheduler 与其他 owner 不读取 Billing database。Provider payload 不直接决定
tenant；生产从 `payment_provider_account` 映射 external account，payload tenant 若存在只作一致性检查。

## 3. 身份与授权

### 用户 JWT

生产模式使用远程 JWKS 验证 RS256、issuer 和可选 audience。`sub` 是 subject，`tenant_id` 必须是合法 tenant value，且必须
与 `X-Kokoro-Tenant-Id` 完全一致。验证失败返回空 context，不将未验证 claim 传入 application。

### Web BFF

Catalog/checkout 的 BFF alternative 同时验证：

- 精确 caller `web-bff`；
- `X-Kokoro-Internal-Secret`；
- 独立 Bearer `BILLING_BFF_SERVICE_TOKEN`；
- 合法 tenant；checkout 还要求合法 subject。

出现任何 internal marker 后不会回退到用户路径，避免伪造/残缺 service header 降级。

### Internal service

`X-Kokoro-Service` 必须来自注册集合，且 shared internal secret 与 tenant context 均有效；route 再限制允许的 service：
admission/execution 是 agent/model/studio，refund accept 是 payment-worker，expiry 是 scheduler，settlement accept 当前允许
payment-worker 或 scheduler。

### Admin

Admin route 要求 caller `admin`、独立 `BILLING_OPERATOR_PROXY_SECRET`、operator identity、tenant 和精确
`billing.admin` role。生产启动会拒绝 operator proxy secret 与 internal service secret 相同。

### Provider webhook

Enabled provider 必须属于 production registry `stripe|alipay|wechat` 并配置 non-empty verification material。Stripe 从 raw JSON 与
`Stripe-Signature` 验证；WeChat 从 raw JSON 与 timestamp/nonce/signature headers 验证；Alipay 只从 form-urlencoded raw body
读取 `sign` 和 `sign_type=RSA2`。Query signature、合成 header 与 fixture `mockSignature` 都不属于生产入口。WeChat 启用时 APIv3
key 必须恰好 32 UTF-8 bytes。验证成功后才写 inbox；provider + external event ID 与 payload hash 用于重放/冲突判断。

## 4. Tenant 与数据访问

- Tenant 只从已验证 JWT/service/admin context 或 provider-account mapping 进入 application。
- HTTP body/query 不接受 caller-selected tenant/account。
- Repository 的 SELECT/INSERT/UPDATE/DELETE 显式带 tenant predicate；同 owner JOIN 同时连接两侧 tenant。
- 无 FK 的关系在 application transaction 中做 existence/state/permission 检查、固定顺序锁、UNIQUE/CHECK 与 reconciliation。
- PostgreSQL connection 通过 request/worker context 隔离事务，避免跨请求共享 transaction client。

当前 Schema 没有 PostgreSQL RLS；tenant 安全依赖应用/repository predicate 与测试门禁。数据库 credential 必须只授予 Billing
runtime，其他仓库和人工查询使用独立最小权限角色。

## 5. 输入、输出与错误

- 已定义 JSON route 使用 Zod strict schema；未知字段在主要 mutation 上被拒绝。
- Idempotency-Key 限制为 8–128 printable ASCII；金额/currency/identity/limit 有边界检查。
- Mutation 的幂等 security boundary 是 tenant-scoped PostgreSQL receipt/owner fact：key、command identity 与规范化 digest 必须
  一致；admission receipt 还包含 API surface。Capture/release/execution 的可信 receipt/event 字段、refund 的 provider identity、
  checkout 的完整 quote 都进入带版本 digest，不能在 transport 解析后丢弃。
- Canonical JSON 在所有 object 深度排序 key、保留 array 顺序并拒绝 `undefined`、non-finite number、BigInt、Date、cycle 等非 JSON
  值；相同语义字段重排不会变成新命令，array 重排仍会被视为 payload drift。
- Redis 仅接收 scoped key-presence marker 或 best-effort lease，不接收 body/digest，也不因字段顺序、坏记录、初始连接失败或运行中
  故障否决命令。PostgreSQL 健康时 readiness 保持 200 并显式报告 `redis=degraded`。
- v1 外部字段 snake_case，错误归一为稳定 `billing.*` code；内部异常不回传 SQL、stack 或 provider 原文。
- Succeeded durable result 缺失/损坏归类为 typed persistence invariant；外部固定 generic `billing.internal_error` 500，只有结构化
  server log 保存 `internal_error_code`，避免向 caller 泄漏数据库内部状态。
- Provider body 以原始字符串保留用于签名，再解析为 object。
- Request ID/trace ID 只接受有限长度 printable value，否则生成/回退本地 ID。

## 6. Secret 与日志

Secret 只能由部署 secret store 注入，不写入 Git、contract、日志、metric label 或 incident ticket：

| 配置 | 用途 |
|---|---|
| `INTERNAL_SERVICE_SECRET` | internal service credential |
| `BILLING_BFF_SERVICE_TOKEN` | BFF 独立 bearer |
| `BILLING_OPERATOR_PROXY_SECRET` | admin gateway credential |
| `PROVIDER_WEBHOOK_SECRETS_JSON` | provider webhook verification material |
| `WECHAT_API_V3_KEY` | WeChat resource decrypt key |
| `STRIPE_SECRET_KEY` | Stripe API credential |

Fastify 禁用默认 request logging，只记录 service、operation、request_id、trace_id、result、duration。Logger redaction 已覆盖
Authorization、cookie、internal secret 与主要 provider signature headers。Provider payload、receipt、quote snapshot、subject 和
tenant 不应进入普通 info 日志。

`.env.example` 中的 `BILLING_REDEEM_SECRET` 当前没有被 API runtime config 读取；它不是已验证的生产配置要求，后续应随 redeem
surface 决策删除或接入 secret validation。

## 7. 供应链与发布

- pnpm 与 Node major 固定；lockfile 是依赖事实。
- Docker base 以 SHA-256 digest 固定，production install 使用 `--ignore-scripts`，runtime 为 non-root 且有 HEALTHCHECK。
- CI 使用 Trivy 阻断 HIGH/CRITICAL dependency、misconfiguration 与 secret 发现。
- Release 先 build/load candidate，再 image scan 与 health/ready smoke；之后才 push，生成 SBOM/max provenance 并用 Cosign 签名 digest。
- GitHub Actions 均固定完整 commit SHA。

这些是配置中的门禁，不等于某次 release 已实际执行；实际证据必须引用 workflow run 与 image digest。

## 8. 已知安全缺口

1. 没有显式 HTTP rate limit、总体 request deadline、response-size limit、per-route body limit 或取消传播门禁。
2. PostgreSQL 没有 RLS，append-only 表也没有数据库 privilege/trigger 防止 runtime role UPDATE/DELETE。
3. 当前 redaction 列表未显式列出 `x-kokoro-proxy-secret`；默认 request logging 已关闭，但仍应补防御性 redaction test。
4. 生产只强制 admin proxy secret 与 internal secret 不同，未显式验证 BFF token 与其他 secret 的互异/最小强度。
5. `internal-header` 只在 `NODE_ENV=production` 时被禁止；部署环境必须确保 production flag 不可遗漏。
6. 没有仓内 threat model test、DAST、rate-abuse test、credential rotation drill 或 production audit evidence。
7. Settlement/expiry 与 webhook provider/signature 已有精确 gate；其余 contract body/error shape 尚不完整，自动验证不能覆盖全部
   边界收紧/放宽风险。
8. Retention、数据主体删除、backup encryption 与 restore access policy 尚未落地。

处置和 secret 泄漏步骤见 [`RUNBOOK.md`](RUNBOOK.md)。


## B8-D3 目标数据库保护（待实施）

采用TECHNICAL_DESIGN B8-D3分离deployer、runtime、reconciliation reader。对象owner即使撤销自己的普通权限仍可重新GRANT，因此生产runtime/reader不得为owner或能继承/切换至owner；单用REVOKE不是owner隔离。应用不给DELETE/TRUNCATE/DDL，reader只有具名SELECT；权限清单默认拒绝未分类的新表/列，不用宽泛ALL/default GRANT掩盖差异。

Root在自建PG18.4库的15项权限探针已实证：独立NOLOGIN runtime以SET LOCAL ROLE测试可读/追加journal，UPDATE/DELETE/TRUNCATE/DDL均42501；单表和无OF的JOIN FOR UPDATE同样42501；只锁获有限UPDATE权限的account可行；tenant字段UPDATE被拒；reader INSERT被拒；独立owner可重授UPDATE。所有变更用例回滚。探针验证对象ACL语义，不证明真实登录认证、生产membership或全业务兼容；旧事实行锁必须先在完整事务迁移中承接，再启用目标ACL。

保留profile首期preserve，无自动业务表删除；不把长期留存声明成地区合规。日志/report避免敏感payload和checkout能力URL，原始证据裁剪须另证签名/恢复/幂等不受破坏。运行时只有业务DB凭据，不向CLI/worker注入DDL管理连接；reader扫描失败输出稳定诊断，不泄露SQL连接串/自由错误。

官方语义核验2026-09-10：[PostgreSQL privileges](https://www.postgresql.org/docs/18/ddl-priv.html)、[GRANT](https://www.postgresql.org/docs/18/sql-grant.html)、[default privileges](https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html)、[read-only transactions](https://www.postgresql.org/docs/18/sql-set-transaction.html)。具体授权清单与运行时约束属于本项目取舍，真实生产执行仍待验。
