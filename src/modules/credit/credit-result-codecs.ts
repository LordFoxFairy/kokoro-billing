import type { ResultCodec } from "../../database/command-receipt.types.js";
import type { GrantCreditResult } from "./credit.types.js";
export const grantResultCodec: ResultCodec<GrantCreditResult> = {
  schemaVersion: 1,
  encode: (value) => value,
  decode(value) {
    const item = value as Partial<Record<keyof GrantCreditResult, unknown>>;
    if (
      !item ||
      typeof item.accountId !== "string" ||
      typeof item.grantId !== "string" ||
      typeof item.journalId !== "string"
    )
      throw new TypeError("Invalid grant result");
    return {
      accountId: item.accountId,
      grantId: item.grantId,
      journalId: item.journalId,
    };
  },
};
export const reserveResultCodec: ResultCodec<{
  holdId: string;
  requestedMicros: string;
}> = {
  schemaVersion: 1,
  encode: (value) => value,
  decode(value) {
    const item = value as { holdId?: unknown; requestedMicros?: unknown };
    if (
      !item ||
      typeof item.holdId !== "string" ||
      typeof item.requestedMicros !== "string"
    )
      throw new TypeError("Invalid reserve result");
    return { holdId: item.holdId, requestedMicros: item.requestedMicros };
  },
};
