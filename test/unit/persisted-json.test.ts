import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PersistedDataInvariantError,
  parsePersistedJson,
} from "../../src/infrastructure/postgres/json.js";
import { classifyBillingError } from "../../src/interfaces/http/server.js";

describe("persisted JSON invariants", () => {
  it("keeps the internal invariant code while exposing only a generic 500", () => {
    let thrown: unknown;
    try {
      parsePersistedJson(
        { accepted: false },
        z.object({ accepted: z.literal(true) }),
        "billing.command_result_invalid",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PersistedDataInvariantError);
    expect(classifyBillingError(thrown)).toEqual({
      statusCode: 500,
      externalCode: "billing.internal_error",
      externalMessage: "internal billing error",
      internalCode: "billing.command_result_invalid",
    });
  });
});
