import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { IamBillingAuthorizationClient } from "../../src/modules/metering/iam-billing-authorization.client.js";
import { IamBillingAuthorizationError } from "../../src/modules/metering/iam-billing-authorization.error.js";
import { resolveIamBillingAuthorizationOptions } from "../../src/modules/metering/iam-billing-authorization.options.js";

const options = () =>
  resolveIamBillingAuthorizationOptions({
    baseUrl: "http://127.0.0.1:1",
    machineBearerToken: "machine-secret-canary",
    deadlineMs: 25,
  });

describe("IAM Billing authorization client boundary", () => {
  it("validates closed options without enumerating the machine credential", () => {
    const resolved = options();
    expect(Object.keys(resolved)).toEqual(["baseUrl", "deadlineMs"]);
    expect(JSON.stringify(resolved)).not.toContain("machine-secret-canary");
    expect(resolved.machineBearerToken).toBe("machine-secret-canary");
    expect(() =>
      resolveIamBillingAuthorizationOptions({
        baseUrl: "http://user:pass@localhost/path?query=1",
        machineBearerToken: "secret",
        deadlineMs: 1,
      }),
    ).toThrow();
    expect(() =>
      resolveIamBillingAuthorizationOptions({
        baseUrl: "http://localhost",
        machineBearerToken: "secret",
        deadlineMs: 1,
        extra: true,
      } as never),
    ).toThrow();
  });

  it("accepts only an origin IAM base URL and reports a fixed secret-safe error", () => {
    expect(
      resolveIamBillingAuthorizationOptions({
        baseUrl: "http://localhost",
        machineBearerToken: "secret",
        deadlineMs: 1,
      }).baseUrl,
    ).toBe("http://localhost");
    expect(
      resolveIamBillingAuthorizationOptions({
        baseUrl: "http://localhost/",
        machineBearerToken: "secret",
        deadlineMs: 1,
      }).baseUrl,
    ).toBe("http://localhost");
    for (const baseUrl of ["http://localhost/iam", "http://localhost/iam/"]) {
      let thrown: unknown;
      try {
        resolveIamBillingAuthorizationOptions({
          baseUrl,
          machineBearerToken: "machine-secret-canary",
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
      expect(JSON.stringify(thrown)).not.toContain("machine-secret-canary");
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

  it("rejects invalid input before transport and remains closed after shutdown", async () => {
    const client = new IamBillingAuthorizationClient(options());
    await expect(
      client.authorize({
        tenantId: "",
        billingSubject: { kind: "user", ref: "user-a" },
        consumptionToken: "user-secret-canary",
        requestId: "request-a",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
    await expect(
      client.authorize({
        tenantId: "tenant-a",
        billingSubject: { kind: "user", ref: "😀".repeat(256) },
        consumptionToken: "user-secret-canary",
        requestId: "request-a",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
    await client.onModuleDestroy();
    await expect(
      client.authorize({
        tenantId: "tenant-a",
        billingSubject: { kind: "user", ref: "user-a" },
        consumptionToken: "user-secret-canary",
        requestId: "request-a",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SHUTTING_DOWN" });
  });
});
