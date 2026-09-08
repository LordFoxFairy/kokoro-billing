import { describe, expect, it } from "vitest";
import {
  findSchemaVerificationResourceError,
  safeSchemaVerificationErrorMessage,
  SchemaVerificationResourceError,
} from "../../scripts/schema-verification.error.js";

describe("schema verification resource errors", () => {
  it("finds a controlled resource through nested aggregate and cause graphs", () => {
    const resource = new SchemaVerificationResourceError(
      "billing_reference_0123456789abcdef0123456789abcdef",
      "creation-unconfirmed",
    );
    const outer = new AggregateError(
      [new Error("TOKEN_DO_NOT_PRINT")],
      "outer secret",
      { cause: new AggregateError([resource], "nested secret") },
    );
    expect(findSchemaVerificationResourceError(outer)).toBe(resource);
    const message = safeSchemaVerificationErrorMessage(outer);
    expect(message).toContain(resource.referenceName);
    expect(message).not.toContain("TOKEN_DO_NOT_PRINT");
    expect(message).not.toContain("secret");
  });

  it("terminates on cycles and ignores uncontrolled resource names", () => {
    const cyclic = new Error("TOKEN_DO_NOT_PRINT");
    cyclic.cause = cyclic;
    const uncontrolled = new SchemaVerificationResourceError(
      "TOKEN_DO_NOT_PRINT",
      "cleanup-failed",
      { cause: cyclic },
    );
    expect(findSchemaVerificationResourceError(uncontrolled)).toBeUndefined();
    expect(safeSchemaVerificationErrorMessage(uncontrolled)).not.toContain(
      "TOKEN_DO_NOT_PRINT",
    );
  });
});
