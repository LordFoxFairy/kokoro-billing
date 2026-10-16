import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../../src/infrastructure/providers/payment/provider-registry.js";
import {
  verifyProviderWebhook,
  parseProviderWebhook,
} from "../../src/application/payment/ports/provider-registry.js";
import { signAlipayNotification } from "../../src/infrastructure/providers/payment/adapters/alipay/alipay-webhook-provider.js";

// Valid provider semantics formerly exercised through the retired v1 transport.
// No substitute HTTP server is retained: v2 webhook transport is not registered.
describe("retained provider signature boundary", () => {
  it("accepts Alipay RSA2 from the signed body and rejects an unsigned body", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const privatePem = privateKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    const publicPem = publicKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    const registry = createProviderRegistry(["alipay"]);
    const params = {
      notify_id: "notify-http-1",
      sign_type: "RSA2",
      app_id: "app-1",
      trade_status: "TRADE_SUCCESS",
      trade_no: "trade-http-1",
    };
    const signed = {
      ...params,
      sign: signAlipayNotification(params, privatePem),
    };
    expect(
      verifyProviderWebhook(
        registry,
        "alipay",
        {},
        Buffer.from(new URLSearchParams(signed).toString()),
        publicPem,
      ),
    ).toBe(true);
    expect(
      verifyProviderWebhook(
        registry,
        "alipay",
        {},
        Buffer.from(new URLSearchParams(params).toString()),
        publicPem,
      ),
    ).toBe(false);
    expect(parseProviderWebhook(registry, "alipay", signed)).toMatchObject({
      providerAccountRef: "app-1",
    });
  });
  it("rejects providers outside the explicit production registry", () => {
    expect(() =>
      parseProviderWebhook(createProviderRegistry([]), "mock", {}),
    ).toThrow();
  });
});
