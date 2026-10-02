import type { FastifyRequest } from "fastify";
import { CreditError } from "./credit.error.js";
import type { CreditLedgerPageInput } from "./credit.types.js";

function parameters(request: FastifyRequest): URLSearchParams {
  if (
    request.body !== undefined ||
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  )
    throw new CreditError(
      "CREDIT_INVALID_QUERY",
      "GET requests do not accept a body",
    );
  return new URL(request.url, "http://billing.invalid").searchParams;
}
export function assertCreditAccountQuery(request: FastifyRequest): void {
  if (parameters(request).size !== 0)
    throw new CreditError("CREDIT_INVALID_QUERY", "Unknown query parameter");
}
export function parseCreditLedgerQuery(
  request: FastifyRequest,
): CreditLedgerPageInput {
  const query = parameters(request);
  for (const name of query.keys()) {
    if (
      (name !== "limit" && name !== "cursor") ||
      query.getAll(name).length !== 1
    )
      throw new CreditError("CREDIT_INVALID_QUERY", "Invalid query parameter");
  }
  const rawLimit = query.get("limit");
  if (
    rawLimit !== null &&
    (!/^[1-9][0-9]*$/u.test(rawLimit) ||
      rawLimit.length > 3 ||
      Number(rawLimit) > 100)
  )
    throw new CreditError("CREDIT_INVALID_QUERY", "Invalid page limit");
  const cursor = query.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 2048))
    throw new CreditError("CREDIT_INVALID_QUERY", "Invalid cursor parameter");
  return {
    limit: rawLimit === null ? 50 : Number(rawLimit),
    ...(cursor === null ? {} : { cursor }),
  };
}
