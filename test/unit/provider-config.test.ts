import { describe, expect, it } from "vitest";
import {
  assertProviderWebhookSecrets,
  assertWechatApiV3Key,
  readEnabledProviders,
  readProviderWebhookSecrets,
} from "../../src/config/provider-config.js";

describe("payment provider runtime configuration", () => {
  it("normalizes enabled providers and rejects unknown values", () => {
    expect(readEnabledProviders(" stripe, wechat ")).toEqual([
      "stripe",
      "wechat",
    ]);
    expect(() => readEnabledProviders("stripe,typo")).toThrow(
      "unsupported BILLING_ENABLED_PROVIDERS: typo",
    );
  });

  it("requires a secret for every enabled webhook provider", () => {
    const secrets = readProviderWebhookSecrets('{"stripe":"secret"}');
    expect(() =>
      assertProviderWebhookSecrets(["stripe"], secrets),
    ).not.toThrow();
    expect(() => assertProviderWebhookSecrets(["wechat"], secrets)).toThrow(
      "PROVIDER_WEBHOOK_SECRETS_JSON.wechat is required",
    );
    expect(() => readProviderWebhookSecrets("[]")).toThrow(
      "must be a JSON object",
    );
  });

  it("requires the WeChat APIv3 key only when WeChat is enabled", () => {
    expect(() => assertWechatApiV3Key(["stripe"], "")).not.toThrow();
    expect(() => assertWechatApiV3Key(["wechat"], "short")).toThrow(
      "exactly 32 UTF-8 bytes",
    );
    expect(() =>
      assertWechatApiV3Key(["wechat"], "12345678901234567890123456789012"),
    ).not.toThrow();
  });
});
