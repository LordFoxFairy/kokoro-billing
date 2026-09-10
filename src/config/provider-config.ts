import type { PaymentProviderKind } from "../application/payment/ports/provider-registry.js";
import { z } from "zod";

const PROVIDER_KINDS = [
  "stripe",
  "alipay",
  "wechat",
] as const satisfies readonly PaymentProviderKind[];
const paymentProviderKindSchema = z.enum(PROVIDER_KINDS);
export const ALL_PAYMENT_PROVIDERS: readonly PaymentProviderKind[] =
  PROVIDER_KINDS;

export function readEnabledProviders(
  raw = process.env.BILLING_ENABLED_PROVIDERS ?? "",
): PaymentProviderKind[] {
  const configured = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const result = z.array(paymentProviderKindSchema).safeParse(configured);
  if (!result.success) {
    const unsupported = configured.filter(
      (value) => !paymentProviderKindSchema.safeParse(value).success,
    );
    throw new Error(
      `unsupported BILLING_ENABLED_PROVIDERS: ${unsupported.join(",")}`,
    );
  }
  return result.data;
}

export function readProviderWebhookSecrets(
  raw = process.env.PROVIDER_WEBHOOK_SECRETS_JSON ?? "{}",
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PROVIDER_WEBHOOK_SECRETS_JSON must be valid JSON");
  }
  const result = z.record(z.string().min(1)).safeParse(parsed);
  if (!result.success)
    throw new Error(
      "PROVIDER_WEBHOOK_SECRETS_JSON must be a JSON object of non-empty strings",
    );
  return result.data;
}

export function assertProviderWebhookSecrets(
  providers: readonly PaymentProviderKind[],
  secrets: Record<string, string>,
): void {
  for (const provider of providers) {
    if (
      typeof secrets[provider] !== "string" ||
      secrets[provider].length === 0
    ) {
      throw new Error(
        `PROVIDER_WEBHOOK_SECRETS_JSON.${provider} is required for an enabled provider`,
      );
    }
  }
}

export function assertWechatApiV3Key(
  providers: readonly PaymentProviderKind[],
  key = process.env.WECHAT_API_V3_KEY ?? "",
): void {
  if (providers.includes("wechat") && Buffer.byteLength(key, "utf8") !== 32) {
    throw new Error(
      "WECHAT_API_V3_KEY must be exactly 32 UTF-8 bytes when wechat is enabled",
    );
  }
}
