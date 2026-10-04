# ADR-0004：IAM SDK immutable artifact 消费

- 状态：Accepted
- 日期：2026-10-04
- 基线：Billing `364f4ba182922f8e370b874fa64ad100c6f10106`

## 背景

Billing 的新 admission 必须调用 IAM owner 的 `verifyBillingAuthorization`，但不得相对导入 sibling 源码、复制 JWT/IAM DTO 或维护第二套 fetch client。IAM 已从 clean commit `0537b2d033d273f0ef7f5017502ba20e8571aba8` 以正式 `sdk:pack` 两次生成相同的私有 Node 24 ESM package：`@kokoro/iam-client@0.7.0`，archive 64012 bytes，SHA-256 `c988e5bd3b234aae0085fced5fcd629bcb3feb3d0fe5ebb5d1a384e44e77c014`。包内 provenance 固定 owner commit、OpenAPI direct digest、生成器/config/lock与运行时。

## 选项

1. **采用：本仓 `vendor/iam/` 保存 owner 原始 tgz 与只读 sidecar。** `package.json` 使用仓内相对 `file:`，lock固定同一archive SHA-512；architecture test核对archive、内外provenance、package manifest、唯一目录内容及lock三处绑定。它是构建依赖制品，不是另一份可编辑IAM contract。
2. **淘汰：在 Billing generated 区从IAM OpenAPI重新生成。** 这会新增第二套生成配置、transport/facade与IAM wire类型，并绕过owner已发布的strict parser/no-retry语义。
3. **暂不要求：公网或远端 Registry。** Registry只是未来immutable locator之一，不是研发门禁；当前仓内content-pinned artifact可在clean clone复现。不得提交`/tmp`绝对路径、sibling/workspace link或mutable branch引用。

## 决定与边界

唯一制品为：

```text
vendor/iam/kokoro-iam-client-0.7.0.tgz
vendor/iam/provenance.json
```

sidecar必须与archive内`package/dist/provenance.json`深等。固定package `0.7.0`、owner commit `0537b2d033d273f0ef7f5017502ba20e8571aba8`、contract path `contract/openapi/iam.internal.v1.json`、contract SHA-256 `c8d7af8a365ad5d13eaabccf7f31133e0918ef198bdc3e7c790d90933eae91b2`、archive SHA-256与lock integrity。archive不得手改、解包后重包或从Billing工作树再生成；只从`@kokoro/iam-client` package root导入。`UNLICENSED`表示Kokoro私有分发；随包保留`README.md`与`THIRD_PARTY_NOTICES.md`，其中Hey API与Zod许可声明不删除。

本切片只建立可重复的依赖输入，不实现adapter/runtime，不授予消费、预占或收费成功。token、tenant/user绑定、expiry、deadline/abort/fail-closed与零持久化规则仍由三D0及后继adapter测试承担。

## 升级、删除与验证

升级必须由IAM owner新clean commit正规pack；先验证新archive/provenance/package/API，再原子替换tgz、sidecar、manifest、lock、architecture pin及三D0 owner pin。一个版本只保留一个archive，删除旧tgz与旧lock记录；不保兼容alias、双包或fallback。若owner改为Root批准的远端content-addressed locator，同样保留version/commit/contract/archive digest与根入口边界，确认所有consumer已切换后删除vendor两文件。

当前门：Node `24.20.0`、Corepack pnpm `11.25.0`，frozen install；architecture test；format/lint/typecheck/test/build/generated checks由Root在clean clone执行。真实IAM HTTP、PostgreSQL零写与费用链属于后继，不能由artifact门替代。
