import type { OpenMyCreditAccountData } from "../../src/generated/billing-api/types.gen.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  assertCreditAccountContract,
  creditAccountBaselineSource,
  creditAccountBaselineDigest,
} from "../../scripts/credit-account-contract.js";

type Document = {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
};
const source = () => readFile("contract/openapi/v2/openapi.yaml", "utf8");
describe("SET55 explicit own account contract", () => {
  it("publishes the machine-only naturally idempotent opening operation", async () => {
    const raw = await source();
    const doc = parse(raw) as Document;
    const op = doc.paths["/v2/billing/me/credit-account"]?.put as Record<
      string,
      unknown
    >;
    const subjectRequired: Record<never, never> extends Pick<
      NonNullable<OpenMyCreditAccountData["headers"]>,
      "x-kokoro-subject"
    >
      ? false
      : true = true;
    expect(subjectRequired).toBe(true);
    expect(op.parameters).toContainEqual(
      expect.objectContaining({
        name: "x-kokoro-subject",
        in: "header",
        required: true,
      }),
    );
    expect(op.operationId).toBe("openMyCreditAccount");
    expect(op["x-kokoro-idempotency"]).toBe("inherent");
    expect(op.security).toEqual([
      {
        serviceCaller: [],
        internalSecret: [],
        serviceBearer: [],
        tenantContext: [],
        subjectContext: [],
      },
    ]);
    expect(doc.components.schemas.OpenCreditAccountRequest).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(() => assertCreditAccountContract(raw)).not.toThrow();
    expect(Object.keys(doc.components.schemas)).toHaveLength(43);
  });
  it("restores the complete immutable exp5 source and its old 24 operations", async () => {
    const old = creditAccountBaselineSource(await source());
    expect(createHash("sha256").update(old).digest("hex")).toBe(
      creditAccountBaselineDigest,
    );
    const doc = parse(old) as Document;
    expect(doc.info.version).toBe("3.0.0-experimental.5");
    expect(
      Object.values(doc.paths).flatMap((path) =>
        Object.keys(path).filter((key) =>
          ["get", "post", "put", "patch", "delete"].includes(key),
        ),
      ),
    ).toHaveLength(24);
  });
  for (const [label, before, after] of [
    [
      "direct user",
      "x-kokoro-permission: web-bff-delegated-self",
      "x-kokoro-permission: authenticated-user",
    ],
    [
      "write retry policy",
      "x-kokoro-idempotency: inherent\n      x-kokoro-permission: web-bff-delegated-self",
      "x-kokoro-idempotency: required\n      x-kokoro-permission: web-bff-delegated-self",
    ],
    [
      "request expansion",
      "    OpenCreditAccountRequest:\n      type: object\n      properties: {}\n      additionalProperties: false",
      "    OpenCreditAccountRequest:\n      type: object\n      additionalProperties: true",
    ],
    [
      "optional delegated subject",
      "name: x-kokoro-subject\n          in: header\n          required: true",
      "name: x-kokoro-subject\n          in: header\n          required: false",
    ],
    ["disabled code", "billing.credit_account_disabled", "billing.forbidden"],
    [
      "historical title",
      "title: Kokoro Billing Internal Owner API",
      "title: Changed",
    ],
    ["historical whitespace", "openapi: 3.1.0", "openapi: 3.1.0 "],
    [
      "request-id response header",
      "    put:\n",
      "    put:\n      extra: true\n",
    ],
  ] as const)
    it(`rejects ${label} mutation`, async () => {
      const raw = await source();
      expect(raw).toContain(before);
      expect(() =>
        assertCreditAccountContract(raw.replace(before, after)),
      ).toThrow();
    });
  for (const kind of [
    "body",
    "status",
    "operation",
    "headers",
    "security",
  ] as const)
    it(`rejects missing or expanded ${kind}`, async () => {
      const doc = parse(await source()) as Document;
      const path = doc.paths["/v2/billing/me/credit-account"];
      if (path === undefined) throw new Error("Missing account path");
      const op = path.put as {
        responses: Record<string, { headers?: unknown }>;
        requestBody?: unknown;
        security?: unknown;
      };
      if (kind === "body") delete op.requestBody;
      if (kind === "status") op.responses["201"] = {};
      if (kind === "operation") delete path.put;
      if (kind === "headers") {
        const success = op.responses["200"];
        if (success === undefined) throw new Error("Missing success response");
        delete success.headers;
      }
      if (kind === "security") op.security = [];
      expect(() => assertCreditAccountContract(stringify(doc))).toThrow();
    });
});
