import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { assertBillingIdentity } from "../../infrastructure/auth/billing-identity-header.js";

export type CatalogCursor = Readonly<{
  version: 1;
  scope: "commerce.catalog";
  tenantId: string;
  offerKey: string;
  revision: number;
  revisionId: string;
}>;
export type CatalogQuery = Readonly<{ limit: number; cursor?: CatalogCursor }>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export function decodeCatalogCursor(
  value: string,
  tenantId: string,
): CatalogCursor {
  const invalid = () => new BadRequestException();
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw invalid();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalid();
  const row = parsed as Record<string, unknown>;
  const keys = [
    "version",
    "scope",
    "identityDigest",
    "offerKey",
    "revision",
    "revisionId",
  ];
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key)) ||
    row.version !== 1 ||
    row.scope !== "commerce.catalog" ||
    row.identityDigest !== identityDigest(tenantId) ||
    typeof row.offerKey !== "string" ||
    row.offerKey.length === 0 ||
    [...row.offerKey].length > 255 ||
    row.offerKey.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(row.offerKey) ||
    !Number.isInteger(row.revision) ||
    typeof row.revision !== "number" ||
    row.revision < 1 ||
    row.revision > 2147483647 ||
    typeof row.revisionId !== "string" ||
    !uuid.test(row.revisionId)
  )
    throw invalid();
  try {
    assertBillingIdentity(tenantId, "tenant");
  } catch {
    throw invalid();
  }
  return {
    version: 1,
    scope: "commerce.catalog",
    tenantId,
    offerKey: row.offerKey,
    revision: row.revision,
    revisionId: row.revisionId,
  };
}
export function encodeCatalogCursor(cursor: CatalogCursor): string {
  const wire = Buffer.from(
    JSON.stringify({
      version: cursor.version,
      scope: cursor.scope,
      identityDigest: identityDigest(cursor.tenantId),
      offerKey: cursor.offerKey,
      revision: cursor.revision,
      revisionId: cursor.revisionId,
    }),
    "utf8",
  ).toString("base64url");
  decodeCatalogCursor(wire, cursor.tenantId);
  return wire;
}
export function parseCatalogQuery(
  request: FastifyRequest,
  tenantId: string,
): CatalogQuery {
  if (
    request.body !== undefined ||
    request.headers["content-length"] !== undefined ||
    request.headers["transfer-encoding"] !== undefined
  )
    throw new BadRequestException();
  const query = new URL(request.url, "http://billing.invalid").searchParams;
  for (const name of query.keys())
    if (
      (name !== "limit" && name !== "cursor") ||
      query.getAll(name).length !== 1
    )
      throw new BadRequestException();
  const limit = query.get("limit");
  if (
    limit !== null &&
    (!/^[1-9][0-9]{0,2}$/u.test(limit) || Number(limit) > 100)
  )
    throw new BadRequestException();
  const cursor = query.get("cursor");
  return {
    limit: limit === null ? 50 : Number(limit),
    ...(cursor === null
      ? {}
      : { cursor: decodeCatalogCursor(cursor, tenantId) }),
  };
}

function identityDigest(tenantId: string): string {
  try {
    assertBillingIdentity(tenantId, "tenant");
  } catch {
    throw new BadRequestException();
  }
  return createHash("sha256")
    .update("kokoro.billing.commerce.catalog.tenant.v1\0")
    .update(tenantId, "utf8")
    .digest("base64url");
}
