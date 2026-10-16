import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PersistedDataInvariantError,
  parsePersistedJson,
} from "../../src/infrastructure/postgres/json.js";
import { ErrorFilter } from "../../src/http/error.filter.js";
import type { ArgumentsHost } from "@nestjs/common";
import { toPersistedJson } from "../../src/database/persisted-json.js";

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
    let status: number | undefined;
    let body: unknown;
    const reply = {
      code: (value: number) => {
        status = value;
        return reply;
      },
      send: (value: unknown) => {
        body = value;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => reply }),
    } as ArgumentsHost;
    new ErrorFilter({
      names: ["ErrorResponse"],
      assert: () => undefined,
    }).catch(thrown, host);
    expect(status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "billing.internal_error",
        message: "Internal error",
        retryable: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain(
      "billing.command_result_invalid",
    );
  });
});

describe("database persisted JSON boundary", () => {
  it.each([
    { lost: undefined },
    { amount: Number.NaN },
    { callback: () => undefined },
    { at: new Date() },
    1n,
  ])("rejects values that JSON serialization would alter: %o", (value) => {
    expect(() => toPersistedJson(value)).toThrow(TypeError);
  });

  it("accepts finite JSON primitives, dense arrays, and plain objects", () => {
    expect(toPersistedJson({ value: [null, 1, true, "ok"] })).toEqual({
      value: [null, 1, true, "ok"],
    });
  });
});
