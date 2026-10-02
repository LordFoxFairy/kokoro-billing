import type {
  CreditAccountResponse,
  CreditLedgerResponse,
} from "../../generated/billing-api/types.gen.js";
import { CreditError } from "./credit.error.js";
import type {
  CreditAccountSnapshot,
  CreditLedgerPage,
} from "./credit.types.js";

function decimal(value: bigint): string {
  if (typeof value !== "bigint")
    throw new CreditError("CREDIT_READ_CORRUPT", "Invalid credit amount");
  return value.toString();
}
export function mapCreditAccount(
  account: CreditAccountSnapshot,
): CreditAccountResponse {
  if (account.status !== "active" && account.status !== "disabled")
    throw new CreditError(
      "CREDIT_READ_CORRUPT",
      "Invalid credit account state",
    );
  return {
    data: {
      credit_account_id: account.id,
      status: account.status,
      available_micros: decimal(account.availableMicros),
      held_micros: decimal(account.heldMicros),
    },
  };
}
export function mapCreditLedger(page: CreditLedgerPage): CreditLedgerResponse {
  return {
    data: {
      items: page.items.map((item) => {
        if (
          !(item.createdAt instanceof Date) ||
          !Number.isFinite(item.createdAt.getTime())
        )
          throw new CreditError(
            "CREDIT_READ_CORRUPT",
            "Invalid journal instant",
          );
        return {
          journal_id: item.journalId,
          sequence: decimal(item.sequence),
          delta_micros: decimal(item.deltaMicros),
          balance_after_micros: decimal(item.balanceAfterMicros),
          source_kind: item.sourceKind,
          source_ref: item.sourceRef,
          created_at: item.createdAt.toISOString(),
        };
      }),
      page: { next_cursor: page.nextCursor },
    },
  };
}
