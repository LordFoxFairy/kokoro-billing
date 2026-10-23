import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { IamBillingAuthorizationClient } from "../../src/modules/metering/iam-billing-authorization.client.js";
import { IamBillingAuthorizationError } from "../../src/modules/metering/iam-billing-authorization.error.js";
import { resolveIamBillingAuthorizationOptions } from "../../src/modules/metering/iam-billing-authorization.options.js";

const options = () =>
  resolveIamBillingAuthorizationOptions({
    baseUrl: "http://127.0.0.1:1",
    serviceCredentialFile: "/private/iam-service-credentials.json",
    deadlineMs: 25,
  });

describe("IAM Billing authorization client boundary", () => {
  it("validates closed options without enumerating the machine credential", () => {
    const resolved = options();
    expect(Object.keys(resolved)).toEqual(["baseUrl", "deadlineMs"]);
    expect(JSON.stringify(resolved)).not.toContain(
      "/private/iam-service-credentials.json",
    );
    expect(resolved.serviceCredentialFile).toBe(
      "/private/iam-service-credentials.json",
    );
    expect(() =>
      resolveIamBillingAuthorizationOptions({
        baseUrl: "http://user:pass@localhost/path?query=1",
        serviceCredentialFile: "/private/iam-service-credentials.json",
        deadlineMs: 1,
      }),
    ).toThrow();
    expect(() =>
      resolveIamBillingAuthorizationOptions({
        baseUrl: "http://localhost",
        serviceCredentialFile: "/private/iam-service-credentials.json",
        deadlineMs: 1,
        extra: true,
      } as never),
    ).toThrow();
  });

  it("accepts only an origin IAM base URL and reports a fixed secret-safe error", () => {
    expect(
      resolveIamBillingAuthorizationOptions({
        baseUrl: "http://localhost",
        serviceCredentialFile: "/private/iam-service-credentials.json",
        deadlineMs: 1,
      }).baseUrl,
    ).toBe("http://localhost");
    expect(
      resolveIamBillingAuthorizationOptions({
        baseUrl: "http://localhost/",
        serviceCredentialFile: "/private/iam-service-credentials.json",
        deadlineMs: 1,
      }).baseUrl,
    ).toBe("http://localhost");
    for (const baseUrl of ["http://localhost/iam", "http://localhost/iam/"]) {
      let thrown: unknown;
      try {
        resolveIamBillingAuthorizationOptions({
          baseUrl,
          serviceCredentialFile: "/private/iam-service-credentials.json",
          deadlineMs: 1,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ZodError);
      if (!(thrown instanceof ZodError)) throw new Error("expected ZodError");
      expect(thrown.issues.map((issue) => issue.message)).toEqual([
        "IAM base URL is invalid",
      ]);
      expect(JSON.stringify(thrown)).not.toContain(
        "/private/iam-service-credentials.json",
      );
    }
  });

  it("uses fixed secret-safe error messages and retry semantics", () => {
    const unavailable = new IamBillingAuthorizationError("UNAVAILABLE");
    expect(unavailable).toMatchObject({
      name: "IamBillingAuthorizationError",
      code: "UNAVAILABLE",
      retryable: true,
      message: "Billing authorization is unavailable",
    });
    expect(new IamBillingAuthorizationError("DENIED").retryable).toBe(false);
  });

  it("rejects malformed identity/proof and inexact lease generations before transport", async () => {
    const client = new IamBillingAuthorizationClient(options());
    const valid = {
      tenantId: "tenant-a",
      payerUserId: "user-a",
      runId: "run-a",
      executionSessionId: "conversation-a",
      leaseGeneration: "7",
      requestBindingSha256: "a".repeat(64),
      executionProof: "proof-canary",
      requestId: "request-a",
      signal: new AbortController().signal,
    };
    for (const delta of [
      { tenantId: "" },
      { payerUserId: "😀".repeat(256) },
      { runId: "" },
      { executionSessionId: "\u0000" },
      { leaseGeneration: "0" },
      { leaseGeneration: "01" },
      { leaseGeneration: "9007199254740992" },
      { leaseGeneration: "18446744073709551615" },
      { requestBindingSha256: "F".repeat(64) },
      { executionProof: " " },
      { executionProof: "a".repeat(16385) },
    ]) {
      await expect(
        client.authorize({ ...valid, ...delta }),
      ).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
    }
    await client.onModuleDestroy();
    await expect(client.authorize(valid)).rejects.toMatchObject({
      code: "SHUTTING_DOWN",
    });
  });
});
