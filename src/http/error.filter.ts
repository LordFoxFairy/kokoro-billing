import { ModelAdmissionError } from "../modules/metering/model-admission.error.js";
import { AgentUsageReaderError } from "../modules/metering/agent-usage-evidence-reader.error.js";
import { IamBillingAuthorizationError } from "../modules/metering/iam-billing-authorization.error.js";
import { MeteringError } from "../modules/metering/metering.error.js";
import { CommandReceiptError } from "../database/command-receipt.error.js";
import { Catch, HttpException, Inject, Injectable } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { DatabaseError } from "pg";
import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
} from "@prisma/client/runtime/client";
import { CreditError } from "../modules/credit/credit.error.js";
import { TransactionContextError } from "../database/transaction.error.js";
import { BILLING_SCHEMA_VALIDATOR } from "../infrastructure/auth/billing-auth.types.js";
import type { BillingSchemaValidator } from "../infrastructure/auth/billing-auth.types.js";
import type { ErrorResponse } from "../generated/billing-api/types.gen.js";

const errors = {
  400: {
    code: "billing.invalid_request",
    message: "Invalid request",
    retryable: false,
  },
  401: {
    code: "billing.unauthenticated",
    message: "Authentication required",
    retryable: false,
  },
  403: {
    code: "billing.forbidden",
    message: "Access denied",
    retryable: false,
  },
  404: {
    code: "billing.not_found",
    message: "Resource not found",
    retryable: false,
  },
  409: {
    code: "billing.idempotency_conflict",
    message: "Command identity conflicts",
    retryable: false,
  },
  422: {
    code: "billing.invalid_state",
    message: "Operation is not eligible in the current state",
    retryable: false,
  },
  500: {
    code: "billing.internal_error",
    message: "Internal error",
    retryable: false,
  },
  503: {
    code: "billing.dependency_unavailable",
    message: "Dependency unavailable",
    retryable: true,
  },
} as const;
type Status = keyof typeof errors;
// Inspect only native Prisma failure metadata, never a caller's arbitrary object.
function budgetSqlState(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (
    [node.code, node.originalCode].some(
      (code) => code === "57014" || code === "55P03",
    )
  )
    return true;
  return [node.cause, node.meta, node.driverAdapterError].some((nested) =>
    budgetSqlState(nested, depth + 1),
  );
}
function dependency(error: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (error instanceof TransactionContextError)
    return error.code === "DATABASE_NOT_READY";
  if (error instanceof PrismaClientInitializationError) return true;
  if (error instanceof DatabaseError && error.code !== undefined)
    return (
      ["57014", "55P03", "53300", "57P01", "57P02", "57P03"].includes(
        error.code,
      ) || /^08[0-9A-Z]{3}$/u.test(error.code)
    );
  if (error instanceof PrismaClientKnownRequestError) {
    if (["P1001", "P1002", "P1008", "P1017", "P2024"].includes(error.code))
      return true;
    const metadata = error.meta;
    if (budgetSqlState(metadata)) return true;
    return dependency(error.cause, depth + 1);
  }
  // The transaction lifecycle preserves its primary native failure as cause.
  if (error instanceof AggregateError)
    return dependency(error.cause, depth + 1);
  return false;
}
function statusOf(error: unknown): Status {
  if (dependency(error)) return 503;
  if (error instanceof ModelAdmissionError) {
    if (error.code === "INVALID") return 400;
    if (error.code === "FORBIDDEN") return 403;
    if (error.code === "CONFLICT") return 409;
    if (error.code === "EXPIRED" || error.code === "RUN_BLOCKED") return 422;
    return error.code === "CORRUPT" ? 500 : 503;
  }
  if (error instanceof AgentUsageReaderError) {
    if (error.code === "REQUEST_INVALID") return 400;
    if (error.code === "DENIED") return 403;
    if (error.code === "NOT_FOUND") return 404;
    if (error.code === "PREPARATION_UNAVAILABLE") return 422;
    return 503;
  }
  if (error instanceof IamBillingAuthorizationError)
    return [
      "AUTHORIZATION_INVALID",
      "DENIED",
      "BINDING_MISMATCH",
      "EXPIRED",
    ].includes(error.code)
      ? 403
      : 503;
  if (
    error instanceof CommandReceiptError &&
    error.code === "COMMAND_IDEMPOTENCY_CONFLICT"
  )
    return 409;
  if (error instanceof MeteringError) {
    if (
      [
        "PRICE_UNAVAILABLE",
        "METERING_RATE_UNAVAILABLE",
        "METERING_POLICY_UNAVAILABLE",
      ].includes(error.code)
    )
      return 422;
    if (error.code === "METERING_PUBLICATION_FORBIDDEN") return 403;
    if (error.code === "METERING_PUBLICATION_CONFLICT") return 409;
    if (error.code === "METERING_PUBLICATION_UNAVAILABLE") return 503;
    return 500;
  }
  if (error instanceof CreditError) {
    if (error.code === "CREDIT_INSUFFICIENT") return 422;
    if (["CREDIT_INVALID_QUERY", "CREDIT_INVALID_CURSOR"].includes(error.code))
      return 400;
    if (error.code === "CREDIT_ACCOUNT_DISABLED") return 403;
    if (error.code === "CREDIT_IDEMPOTENCY_CONFLICT") return 409;
    return error.code === "CREDIT_ACCOUNT_NOT_FOUND" ? 404 : 500;
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 503
      ? status
      : 500;
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    [
      "FST_ERR_CTP_INVALID_MEDIA_TYPE",
      "FST_ERR_CTP_INVALID_JSON_BODY",
      "FST_ERR_CTP_EMPTY_JSON_BODY",
      "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
      "FST_ERR_CTP_BODY_TOO_LARGE",
      "FST_ERR_VALIDATION",
    ].includes(error.code)
  )
    return 400;
  return 500;
}
@Catch()
@Injectable()
export class ErrorFilter implements ExceptionFilter {
  constructor(
    @Inject(BILLING_SCHEMA_VALIDATOR)
    private readonly schemas: BillingSchemaValidator,
  ) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const status = statusOf(error);
    const response: ErrorResponse = {
      error:
        status === 422 &&
        error instanceof CreditError &&
        error.code === "CREDIT_INSUFFICIENT"
          ? {
              code: "billing.insufficient_credit",
              message: "Insufficient credits",
              retryable: false,
            }
          : status === 422 && error instanceof MeteringError
            ? {
                code: "billing.price_unavailable",
                message: "Explicit model pricing is not available",
                retryable: false,
              }
            : status === 404 &&
                error instanceof CreditError &&
                error.code === "CREDIT_ACCOUNT_NOT_FOUND"
              ? {
                  code: "billing.credit_account_not_found",
                  message: "Credit account not found",
                  retryable: false,
                }
              : status === 403 &&
                  error instanceof CreditError &&
                  error.code === "CREDIT_ACCOUNT_DISABLED"
                ? {
                    code: "billing.credit_account_disabled",
                    message: "Credit account is disabled",
                    retryable: false,
                  }
                : errors[status],
    };
    this.schemas.assert("ErrorResponse", response);
    void host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .code(status)
      .send(response);
  }
}
