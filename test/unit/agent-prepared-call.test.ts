import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { AgentUsageEvidenceReader } from "../../src/modules/metering/agent-usage-evidence-reader.js";

function canonical(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const vectors = JSON.parse(
  await readFile(
    new URL("../../vendor/agent/usage/v2/vectors.json", import.meta.url),
    "utf8",
  ),
) as { positive: { json_utf8: string }[] };
const vector = vectors.positive[0];
if (!vector) throw new Error("missing owner positive");
const source = JSON.parse(vector.json_utf8) as {
  identity: Record<string, unknown>;
  planned: Record<string, unknown>;
};
function fixture() {
  const identity = structuredClone(source.identity);
  delete identity.event_id;
  const planned = structuredClone(source.planned);
  const authorization = {
    state: "requested_unknown",
    request_ref: "billing-attempt-reference",
  };
  const part = (name: string, value: unknown) => {
    const raw = Buffer.from(canonical(value));
    return {
      [`${name}_bytes_base64url`]: raw.toString("base64url"),
      [`${name}_digest`]: createHash("sha256").update(raw).digest("hex"),
    };
  };
  const expected = {
    tenantId: String(identity.tenant_ref),
    runId: String(identity.run_id),
    attemptId: String(identity.attempt_id),
    requestRef: authorization.request_ref,
    attemptBindingDigest: String(
      part("attempt_binding", identity).attempt_binding_digest,
    ),
    plannedDigest: String(part("planned", planned).planned_digest),
    finalRequestDigest: "a".repeat(64),
  };
  const now = Date.now();
  const data: Record<string, unknown> = {
    binding_version: "2.0.0",
    attempt_id: expected.attemptId,
    status: "authorization_pending",
    ...part("attempt_binding", identity),
    ...part("planned", planned),
    ...part("authorization", authorization),
    final_request_binding_version: 1,
    final_request_digest: expected.finalRequestDigest,
    prepared_at: new Date(now - 1000).toISOString(),
    observed_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + 60_000).toISOString(),
  };
  return { data, expected, identity, planned };
}
async function withPeer(
  run: (
    reader: AgentUsageEvidenceReader,
    requests: {
      url: string;
      authorization: string | undefined;
      tenant: string | undefined;
    }[],
  ) => Promise<void>,
  reply: (res: ServerResponse) => void,
) {
  const requests: {
    url: string;
    authorization: string | undefined;
    tenant: string | undefined;
  }[] = [];
  const server = createServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      authorization: req.headers.authorization,
      tenant:
        typeof req.headers["x-kokoro-tenant-ref"] === "string"
          ? req.headers["x-kokoro-tenant-ref"]
          : undefined,
    });
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json");
    res.setHeader("x-request-id", "prepared-test");
    reply(res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const reader = new AgentUsageEvidenceReader({
    baseUrl: `http://127.0.0.1:${address.port}`,
    machineBearerToken: "billing-reader-secret",
    deadlineMs: 1000,
  });
  try {
    await run(reader, requests);
  } finally {
    await reader.onModuleDestroy();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

describe("formal current prepared call consumption", () => {
  it("uses one authenticated owner read and preserves frozen source facts", async () => {
    const f = fixture();
    await withPeer(
      async (reader, requests) => {
        expect(reader).toHaveProperty("readPrepared");
        const result = await reader.readPrepared({
          expected: f.expected,
          requestId: "prepared-test",
          signal: new AbortController().signal,
        });
        expect(result.identity).toEqual(f.identity);
        expect(result.planned).toEqual(f.planned);
        expect(result.attemptBindingDigest).toBe(
          f.expected.attemptBindingDigest,
        );
        expect(result.plannedDigest).toBe(f.expected.plannedDigest);
        expect(result.original.attemptBindingJson).toBe(canonical(f.identity));
        expect(Object.isFrozen(result.identity.actor)).toBe(true);
        expect(requests).toEqual([
          {
            url: `/v1/model-call-attempts/${f.expected.attemptId}/prepared`,
            authorization: "Bearer billing-reader-secret",
            tenant: f.expected.tenantId,
          },
        ]);
      },
      (res) =>
        res.end(
          JSON.stringify({
            data: f.data,
            meta: { request_id: "prepared-test" },
          }),
        ),
    );
  });
  it("rejects a self-consistent but different request reference", async () => {
    const f = fixture();
    await withPeer(
      async (reader) => {
        expect(reader).toHaveProperty("readPrepared");
        await expect(
          reader.readPrepared({
            expected: { ...f.expected, requestRef: "another" },
            requestId: "prepared-test",
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: "CONTRACT_INVALID" });
      },
      (res) =>
        res.end(
          JSON.stringify({
            data: f.data,
            meta: { request_id: "prepared-test" },
          }),
        ),
    );
  });
});

it.each([
  [
    "binding digest",
    (f: ReturnType<typeof fixture>) => {
      f.data.attempt_binding_digest = "0".repeat(64);
    },
  ],
  [
    "final request digest",
    (f: ReturnType<typeof fixture>) => {
      f.data.final_request_digest = "0".repeat(64);
    },
  ],
  [
    "old binding version",
    (f: ReturnType<typeof fixture>) => {
      f.data.binding_version = "1.0.0";
    },
  ],
  [
    "prepared is not pending",
    (f: ReturnType<typeof fixture>) => {
      f.data.status = "prepared";
    },
  ],
  [
    "authorized is not a new hold",
    (f: ReturnType<typeof fixture>) => {
      f.data.status = "authorized";
    },
  ],
  [
    "unknown field",
    (f: ReturnType<typeof fixture>) => {
      f.data.estimated_price = "0";
    },
  ],
  [
    "padded base64",
    (f: ReturnType<typeof fixture>) => {
      f.data.planned_bytes_base64url =
        String(f.data.planned_bytes_base64url) + "=";
    },
  ],
  [
    "numeric version",
    (f: ReturnType<typeof fixture>) => {
      f.data.final_request_binding_version = 2;
    },
  ],
  [
    "observation before prepare",
    (f: ReturnType<typeof fixture>) => {
      f.data.observed_at = "2000-01-01T00:00:00.000Z";
    },
  ],
] as const)(
  "rejects %s without a second owner request",
  async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    await withPeer(
      async (reader, requests) => {
        await expect(
          reader.readPrepared({
            expected: f.expected,
            requestId: "prepared-test",
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: "CONTRACT_INVALID" });
        expect(requests).toHaveLength(1);
      },
      (res) =>
        res.end(
          JSON.stringify({
            data: f.data,
            meta: { request_id: "prepared-test" },
          }),
        ),
    );
  },
);

it("rejects a stale lease on arrival instead of treating it as a renewed permission", async () => {
  const f = fixture();
  f.data.prepared_at = "2000-01-01T00:00:00.000Z";
  f.data.observed_at = "2000-01-01T00:00:01.000Z";
  f.data.lease_expires_at = "2000-01-01T00:00:02.000Z";
  await withPeer(
    async (reader) => {
      await expect(
        reader.readPrepared({
          expected: f.expected,
          requestId: "prepared-test",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "PREPARATION_UNAVAILABLE" });
    },
    (res) =>
      res.end(
        JSON.stringify({ data: f.data, meta: { request_id: "prepared-test" } }),
      ),
  );
});

it("preserves the original request and exact large decimal identity across an await", async () => {
  const f = fixture();
  f.identity.attempt_ordinal = "9007199254740993";
  f.identity.lease = { owner: "lease-worker", generation: "9007199254740993" };
  const raw = Buffer.from(canonical(f.identity));
  f.data.attempt_binding_bytes_base64url = raw.toString("base64url");
  f.data.attempt_binding_digest = createHash("sha256")
    .update(raw)
    .digest("hex");
  f.expected.attemptBindingDigest = String(f.data.attempt_binding_digest);
  await withPeer(
    async (reader) => {
      const input = {
        expected: f.expected,
        requestId: "prepared-test",
        signal: new AbortController().signal,
      };
      const pending = reader.readPrepared(input);
      input.expected.runId = "mutated-late";
      input.requestId = "late-request-id";
      const result = await pending;
      expect(result.identity.attempt_ordinal).toBe("9007199254740993");
      expect(result.identity.lease.generation).toBe("9007199254740993");
    },
    (res) =>
      res.end(
        JSON.stringify({ data: f.data, meta: { request_id: "prepared-test" } }),
      ),
  );
});

it.each(["noncanonical", "duplicate", "event_id", "malformed-utf8"] as const)(
  "rejects self-consistent %s raw identity",
  async (kind) => {
    const f = fixture();
    let value = canonical(f.identity);
    if (kind === "noncanonical") value += " ";
    if (kind === "duplicate")
      value = value.replace("{", '{"tenant_ref":"overridden",');
    if (kind === "event_id")
      value = canonical({
        ...f.identity,
        event_id: "00000000-0000-4000-8000-000000000001",
      });
    const raw =
      kind === "malformed-utf8" ? Buffer.from([255]) : Buffer.from(value);
    f.data.attempt_binding_bytes_base64url = raw.toString("base64url");
    f.data.attempt_binding_digest = createHash("sha256")
      .update(raw)
      .digest("hex");
    f.expected.attemptBindingDigest = String(f.data.attempt_binding_digest);
    await withPeer(
      async (reader) => {
        await expect(
          reader.readPrepared({
            expected: f.expected,
            requestId: "prepared-test",
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: "CONTRACT_INVALID" });
      },
      (res) =>
        res.end(
          JSON.stringify({
            data: f.data,
            meta: { request_id: "prepared-test" },
          }),
        ),
    );
  },
);

it.each([401, 403, 404, 409, 500])(
  "does not retry owner status %s",
  async (status) => {
    const f = fixture();
    await withPeer(
      async (reader, requests) => {
        await expect(
          reader.readPrepared({
            expected: f.expected,
            requestId: "prepared-test",
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({
          code:
            status === 401 || status === 403
              ? "DENIED"
              : status === 404
                ? "NOT_FOUND"
                : "UNAVAILABLE",
        });
        expect(requests).toHaveLength(1);
      },
      (res) => {
        res.statusCode = status;
        res.end("{}");
      },
    );
  },
);

it("checks both representations without widening the original sealed JSON numeric domain", async () => {
  const {
    parseAgentUsageJson,
    parseAgentEvidenceEnvelopeJson,
    parseAgentPreparedEnvelopeJson,
  } = await import("../../src/modules/metering/agent-usage-json.js");
  expect(() => parseAgentUsageJson(Buffer.from('{"version":1}'))).toThrow();
  expect(() =>
    parseAgentEvidenceEnvelopeJson(Buffer.from('{"version":1}')),
  ).toThrow();
  expect(
    parseAgentPreparedEnvelopeJson(Buffer.from('{"version":1.0}')).value,
  ).toEqual({ version: 1 });
  expect(() =>
    parseAgentPreparedEnvelopeJson(Buffer.from('{"version":9007199254740993}')),
  ).toThrow();
});

it("aborts and drains an in-flight prepared read on the same lifecycle", async () => {
  const f = fixture();
  await withPeer(
    async (reader) => {
      const controller = new AbortController();
      const pending = reader.readPrepared({
        expected: f.expected,
        requestId: "prepared-test",
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
      const next = reader.readPrepared({
        expected: f.expected,
        requestId: "prepared-test",
        signal: new AbortController().signal,
      });
      const rejection = expect(next).rejects.toMatchObject({
        code: "SHUTTING_DOWN",
      });
      await reader.onModuleDestroy();
      await rejection;
      await expect(
        reader.readPrepared({
          expected: f.expected,
          requestId: "prepared-test",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "SHUTTING_DOWN" });
    },
    () => {},
  );
});

it("has a separate bounded wrapper without increasing any raw part budget", async () => {
  const f = fixture();
  const envelope = JSON.stringify({
    data: f.data,
    meta: { request_id: "prepared-test" },
  });
  const {
    MAX_AGENT_EVIDENCE_RESPONSE_BYTES,
    MAX_AGENT_PREPARED_RESPONSE_BYTES,
  } = await import("../../src/modules/metering/agent-usage-json.js");
  await withPeer(
    async (reader) => {
      expect(
        (
          await reader.readPrepared({
            expected: f.expected,
            requestId: "prepared-test",
            signal: new AbortController().signal,
          })
        ).identity.attempt_id,
      ).toBe(f.expected.attemptId);
    },
    (res) =>
      res.end(envelope.padEnd(MAX_AGENT_EVIDENCE_RESPONSE_BYTES + 1, " ")),
  );
  await withPeer(
    async (reader) => {
      await expect(
        reader.readPrepared({
          expected: f.expected,
          requestId: "prepared-test",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "CONTRACT_INVALID" });
    },
    (res) =>
      res.end(envelope.padEnd(MAX_AGENT_PREPARED_RESPONSE_BYTES + 1, " ")),
  );
  const raw = Buffer.alloc(65537, 32);
  f.data.planned_bytes_base64url = raw.toString("base64url");
  f.data.planned_digest = createHash("sha256").update(raw).digest("hex");
  f.expected.plannedDigest = String(f.data.planned_digest);
  await withPeer(
    async (reader) => {
      await expect(
        reader.readPrepared({
          expected: f.expected,
          requestId: "prepared-test",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "CONTRACT_INVALID" });
    },
    (res) =>
      res.end(
        JSON.stringify({ data: f.data, meta: { request_id: "prepared-test" } }),
      ),
  );
});

it("rejects malformed trusted input or prior cancellation before any network operation", async () => {
  const f = fixture();
  await withPeer(
    async (reader, requests) => {
      await expect(
        reader.readPrepared({
          expected: { ...f.expected, attemptId: "not-a-uuid" },
          requestId: "prepared-test",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      const controller = new AbortController();
      controller.abort();
      await expect(
        reader.readPrepared({
          expected: f.expected,
          requestId: "prepared-test",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "ABORTED" });
      expect(requests).toEqual([]);
    },
    (res) => res.end("{}"),
  );
});
