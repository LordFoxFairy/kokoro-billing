import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { CreditError } from "./credit.error.js";
import type { CreditLedgerCursor, CreditReadContext } from "./credit.types.js";

export function decodeCreditLedgerCursor(
  value: unknown,
  context: CreditReadContext,
): CreditLedgerCursor {
  const invalid = () =>
    new CreditError("CREDIT_INVALID_CURSOR", "Invalid Credit ledger cursor");
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalid();
  let decoded: unknown;
  try {
    const json = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    decoded = JSON.parse(json) as unknown;
  } catch {
    throw invalid();
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
    throw invalid();
  const fields = decoded as Record<string, unknown>;
  const keys = [
    "version",
    "scope",
    "identityDigest",
    "accountId",
    "highWaterSequence",
    "lastSequence",
  ];
  if (
    Object.keys(fields).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(fields, key)) ||
    fields.version !== 1 ||
    fields.scope !== "credit.ledger" ||
    fields.identityDigest !== identityDigest(context) ||
    typeof fields.accountId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
      fields.accountId,
    ) ||
    typeof fields.highWaterSequence !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(fields.highWaterSequence) ||
    typeof fields.lastSequence !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(fields.lastSequence)
  )
    throw invalid();
  const highWaterSequence = BigInt(fields.highWaterSequence);
  const lastSequence = BigInt(fields.lastSequence);
  if (
    lastSequence > highWaterSequence ||
    highWaterSequence > 9223372036854775807n
  )
    throw invalid();
  return {
    version: 1,
    scope: "credit.ledger",
    tenantId: context.tenantId,
    subjectId: context.subjectId,
    accountId: fields.accountId,
    highWaterSequence,
    lastSequence,
  };
}

export function encodeCreditLedgerCursor(cursor: CreditLedgerCursor): string {
  const encoded = Buffer.from(
    JSON.stringify({
      version: cursor.version,
      scope: cursor.scope,
      identityDigest: identityDigest(cursor),
      accountId: cursor.accountId,
      highWaterSequence: cursor.highWaterSequence.toString(),
      lastSequence: cursor.lastSequence.toString(),
    }),
    "utf8",
  ).toString("base64url");
  decodeCreditLedgerCursor(encoded, cursor);
  return encoded;
}

function identityDigest(context: CreditReadContext): string {
  if (
    !validIdentity(context.tenantId, 191) ||
    !validIdentity(context.subjectId, 255)
  )
    throw new CreditError(
      "CREDIT_INVALID_CURSOR",
      "Invalid Credit ledger cursor",
    );
  const hash = createHash("sha256");
  hash.update("kokoro.billing.credit-ledger.identity.v1\0", "utf8");
  for (const value of [context.tenantId, context.subjectId]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("base64url");
}

function validIdentity(value: unknown, maximum: number): value is string {
  if (typeof value !== "string") return false;
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point === undefined ||
      point === 0 ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      return false;
    length += 1;
    if (length > maximum) return false;
  }
  return length > 0;
}
