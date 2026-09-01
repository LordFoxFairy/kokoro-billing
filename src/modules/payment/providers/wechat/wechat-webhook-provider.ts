import { createDecipheriv, createSign, createVerify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { ParsedWebhookEvent, PaymentWebhookProvider } from "../../provider-types.js";
import { PAYMENT_WEBHOOK_EVENT, WebhookError } from "../../provider-types.js";
import { minorAmount, providerPayloadSiteId, providerPayloadTenantId, webhookMetadataSchema } from "../normalize.js";

export const WECHAT_TIMESTAMP_HEADER = "wechatpay-timestamp";
export const WECHAT_NONCE_HEADER = "wechatpay-nonce";
export const WECHAT_SIGNATURE_HEADER = "wechatpay-signature";
const DEFAULT_TOLERANCE_SECONDS = 300;

// APIv3 通知信封。平台证书公钥负责验签，APIv3 对称密钥负责 resource 解密，二者不是同一个 secret。
const wechatEventSchema = z
  .object({
    id: z.string().min(1),
    event_type: z.string().min(1),
    resource: z
      .object({
        out_trade_no: z.string().optional(),
        metadata: webhookMetadataSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

// WeChat APIv3 待签串：`${timestamp}\n${nonce}\n${body}\n`。
function buildSignContent(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

// 测试向量：用私钥对 APIv3 待签串签名（RSA-SHA256/base64）。
export function signWechatNotification(
  timestamp: string,
  nonce: string,
  rawBody: Buffer | string,
  privateKeyPem: string,
): string {
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signer = createSign("RSA-SHA256");
  signer.update(buildSignContent(timestamp, nonce, body), "utf8");
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

interface WechatProviderOptions {
  toleranceSeconds?: number;
  now?: () => number; // epoch 秒。
  apiV3Key?: string;
}

// WeChat APIv3 验签：RSA-SHA256(平台证书公钥) over `${ts}\n${nonce}\n${body}\n`，含时间戳容差。
// secret = WeChat 平台证书公钥 PEM。
export class WechatWebhookProvider implements PaymentWebhookProvider {
  readonly kind = "wechat" as const;
  private readonly toleranceSeconds: number;
  private readonly now: () => number;
  private readonly apiV3Key?: Buffer;

  constructor(options: WechatProviderOptions = {}) {
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    if (options.apiV3Key !== undefined) {
      const key = Buffer.from(options.apiV3Key, "utf8");
      if (key.length !== 32) throw new Error("wechat APIv3 key must be 32 bytes");
      this.apiV3Key = key;
    }
  }

  verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
    const timestamp = headerValue(headers, WECHAT_TIMESTAMP_HEADER);
    const nonce = headerValue(headers, WECHAT_NONCE_HEADER);
    const signature = headerValue(headers, WECHAT_SIGNATURE_HEADER);
    if (!timestamp || !nonce || !signature) {
      return false;
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > this.toleranceSeconds) {
      return false;
    }
    try {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(buildSignContent(timestamp, nonce, rawBody.toString("utf8")), "utf8");
      verifier.end();
      return verifier.verify(secret, signature, "base64");
    } catch {
      return false;
    }
  }

  parseEvent(payload: unknown): ParsedWebhookEvent {
    const parsed = wechatEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new WebhookError(
        "payment.webhook_payload_invalid",
        "wechat notification payload is invalid: expected { id, event_type }",
        400,
      );
    }
    const { id, event_type } = parsed.data;
    const resource = decryptResource(parsed.data.resource, this.apiV3Key);
    const metadata = webhookMetadataSchema.parse(resource?.metadata ?? {});
    const orderId = metadata.orderId ?? metadata.checkoutId ?? resource?.out_trade_no ?? null;

    if (event_type === "TRANSACTION.SUCCESS") {
      return { eventId: id, eventType: PAYMENT_WEBHOOK_EVENT.paymentSucceeded, payloadTenantId: providerPayloadTenantId(metadata), payloadSiteId: providerPayloadSiteId(metadata), providerAccountRef: typeof resource?.mchid === 'string' ? resource.mchid : null, externalPaymentRef: typeof resource?.transaction_id === 'string' ? resource.transaction_id : id, externalReversalRef: null, refundAmountMinor: null, orderId, subscription: null };
    }
    if (event_type === "REFUND.SUCCESS") {
      const amount = resource?.amount as { refund?: unknown } | undefined;
      return { eventId: id, eventType: PAYMENT_WEBHOOK_EVENT.refundSucceeded, payloadTenantId: providerPayloadTenantId(metadata), payloadSiteId: providerPayloadSiteId(metadata), providerAccountRef: typeof resource?.mchid === 'string' ? resource.mchid : null, externalPaymentRef: null, externalReversalRef: typeof resource?.refund_id === 'string' ? resource.refund_id : id, refundAmountMinor: minorAmount(amount?.refund), orderId, subscription: null };
    }
    return { eventId: id, eventType: event_type, payloadTenantId: providerPayloadTenantId(metadata), payloadSiteId: providerPayloadSiteId(metadata), providerAccountRef: null, externalPaymentRef: null, externalReversalRef: null, refundAmountMinor: null, orderId: null, subscription: null };
  }
}

function decryptResource(resource: z.infer<typeof wechatEventSchema>["resource"], apiV3Key: Buffer | undefined): z.infer<typeof webhookMetadataSchema> & { out_trade_no?: string } {
  if (!resource || typeof resource.ciphertext !== "string") return resource as z.infer<typeof webhookMetadataSchema> & { out_trade_no?: string };
  if (!apiV3Key || typeof resource.nonce !== "string" || typeof resource.associated_data !== "string") {
    throw new WebhookError("payment.webhook_payload_invalid", "wechat encrypted resource requires APIv3 key and envelope fields", 400);
  }
  try {
    const ciphertext = Buffer.from(resource.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", apiV3Key, Buffer.from(resource.nonce, "utf8"));
    decipher.setAAD(Buffer.from(resource.associated_data, "utf8"));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    const value = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("resource must be object");
    return value as z.infer<typeof webhookMetadataSchema> & { out_trade_no?: string };
  } catch {
    throw new WebhookError("payment.webhook_payload_invalid", "wechat encrypted resource could not be decrypted", 400);
  }
}
