import type { RowDataPacket, SqlConnection } from "../../database.js";
import { z } from "zod";

export type SubscriptionView = {
  readonly subscriptionId: string;
  readonly status: string;
  readonly planKey: string;
  readonly periodStart: string;
  readonly periodEnd: string;
};
export type SubscriptionPage = {
  readonly items: readonly SubscriptionView[];
  readonly nextCursor?: string;
};
type SubscriptionRow = RowDataPacket & {
  term_id: string;
  status: string;
  program_key: string;
  period_start: Date | string;
  period_end: Date | string;
};
type SubscriptionCursor = {
  readonly version: 1;
  readonly scope: "subscription.subject";
  readonly tenantId: string;
  readonly subjectId: string;
  readonly periodEnd: string;
  readonly termId: string;
};
const subscriptionCursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal("subscription.subject"),
    tenantId: z.string().min(1),
    subjectId: z.string().min(1),
    periodEnd: z.string().datetime({ offset: true }),
    termId: z.string().min(1),
  })
  .strict();

export class SubscriptionQueryService {
  public constructor(private readonly connection: SqlConnection) {}

  public async listForSubject(
    tenantId: string,
    subjectId: string,
    requestedLimit: number,
    encodedCursor?: string,
  ): Promise<SubscriptionPage> {
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 100);
    const cursor =
      encodedCursor === undefined
        ? undefined
        : decodeSubscriptionCursor(encodedCursor, tenantId, subjectId);
    const cursorPredicate =
      cursor === undefined
        ? ""
        : "AND (period_end < $3 OR (period_end = $3 AND term_id < $4))";
    const values =
      cursor === undefined
        ? [tenantId, subjectId, limit + 1]
        : [
            tenantId,
            subjectId,
            new Date(cursor.periodEnd),
            cursor.termId,
            limit + 1,
          ];
    const limitPlaceholder = cursor === undefined ? "$3" : "$5";
    const [rows] = await this.connection.execute<SubscriptionRow[]>(
      `SELECT term_id, status, program_key, period_start, period_end
         FROM entitlement_subscription_term
        WHERE tenant_id = $1 AND subject_id = $2 ${cursorPredicate}
        ORDER BY period_end DESC, term_id DESC
        LIMIT ${limitPlaceholder}`,
      values,
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => ({
      subscriptionId: row.term_id,
      status: row.status,
      planKey: row.program_key,
      periodStart: new Date(row.period_start).toISOString(),
      periodEnd: new Date(row.period_end).toISOString(),
    }));
    const last = pageRows.at(-1);
    if (!hasMore || last === undefined) return { items };
    return {
      items,
      nextCursor: encodeSubscriptionCursor({
        version: 1,
        scope: "subscription.subject",
        tenantId,
        subjectId,
        periodEnd: new Date(last.period_end).toISOString(),
        termId: last.term_id,
      }),
    };
  }
}

const encodeSubscriptionCursor = (cursor: SubscriptionCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

function decodeSubscriptionCursor(
  value: string,
  tenantId: string,
  subjectId: string,
): SubscriptionCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    const result = subscriptionCursorSchema.safeParse(parsed);
    if (
      !result.success ||
      result.data.tenantId !== tenantId ||
      result.data.subjectId !== subjectId
    )
      throw new Error();
    return result.data;
  } catch {
    throw new Error("billing.invalid_cursor");
  }
}
