import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentUsageEvidenceReader } from "../../src/modules/metering/agent-usage-evidence-reader.js";
import { AgentUsageReaderError } from "../../src/modules/metering/agent-usage-evidence-reader.error.js";
import { resolveAgentUsageReaderOptions } from "../../src/modules/metering/agent-usage-evidence-reader.options.js";
import { MAX_AGENT_EVIDENCE_RESPONSE_BYTES } from "../../src/modules/metering/agent-usage-json.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, mkdir, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  decodeAgentUsageEvidence,
  verifyAgentUsageSuccessor,
  bindSealedAgentUsageEvidence,
} from "../../src/modules/metering/agent-usage-evidence.js";
import { AgentUsageEvidenceError } from "../../src/modules/metering/agent-usage-evidence.error.js";
import {
  generateAgentUsageArtifacts,
  readAgentUsageArtifacts,
} from "../../scripts/generate-agent-usage.js";
import type { ModelUsageEvidence } from "../../src/generated/agent-usage-v2/types.gen.js";
import {
  canonicalAgentUsageJson,
  parseAgentUsageJson,
} from "../../src/modules/metering/agent-usage-json.js";

const root = resolve(import.meta.dirname, "../..");
const vector = z.object({
  id: z.string(),
  json_utf8: z.string(),
  digest: z.string(),
});
const vectors = z
  .object({
    positive: z.array(vector),
    negative: z.array(vector),
    pairs: z.array(
      z.object({
        id: z.string(),
        previous_json_utf8: z.string(),
        incoming_json_utf8: z.string(),
        accepted: z.boolean(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      await readFile(join(root, "vendor/agent/usage/v2/vectors.json"), "utf8"),
    ),
  );
const bytes = (text: string): Uint8Array => Buffer.from(text);
const positive = vectors.positive[0];
if (!positive) throw new Error("missing owner positive");
const original = positive.json_utf8;
const fixture = (): ModelUsageEvidence =>
  JSON.parse(original) as ModelUsageEvidence;
// Independent test encoder; the production canonicalizer is not used to bless fixtures.
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function signed(value: ModelUsageEvidence): string {
  const facts: Partial<ModelUsageEvidence> = { ...value };
  delete facts.digest;
  value.digest = createHash("sha256")
    .update("kokoro-agent:model-usage-evidence:v2\n")
    .update(canonical(facts))
    .digest("hex");
  return JSON.stringify(value);
}

describe("immutable Agent usage2 consumer", () => {
  it.each(vectors.positive)(
    "accepts published $id and preserves exact original bytes",
    (row) => {
      const result = decodeAgentUsageEvidence(bytes(row.json_utf8));
      expect(result.originalJson).toBe(row.json_utf8);
      expect(result.evidence.digest).toBe(row.digest);
      expect(Object.isFrozen(result.evidence.identity.actor)).toBe(true);
      expect(() =>
        Object.assign(result.evidence.planned, { model: "changed" }),
      ).toThrow();
    },
  );
  it.each(vectors.negative)("rejects published $id", (row) => {
    expect(() => decodeAgentUsageEvidence(bytes(row.json_utf8))).toThrow(
      AgentUsageEvidenceError,
    );
  });
  it.each(vectors.pairs)("honors published successor $id", (row) => {
    const run = () =>
      verifyAgentUsageSuccessor(
        bytes(row.previous_json_utf8),
        bytes(row.incoming_json_utf8),
      );
    if (row.accepted) expect(run().originalJson).toBe(row.incoming_json_utf8);
    else expect(run).toThrow(AgentUsageEvidenceError);
  });
  it("retains source whitespace, non-BMP Unicode and large decimal precision", () => {
    const value = fixture();
    value.planned.label = "\u{1F600}\uE000 e\u0301";
    if (value.usage.state !== "normalized") throw new Error("fixture usage");
    value.usage.value.input_total = {
      state: "reported",
      count: "9007199254740993",
    };
    value.usage.value.output_total = { state: "reported", count: "50" };
    value.usage.value.total = { state: "reported", count: "9007199254741043" };
    const raw = ` \n${signed(value)}\t`;
    expect(decodeAgentUsageEvidence(bytes(raw)).originalJson).toBe(raw);
  });
  it("matches a complete trusted snapshot, not just the model or tenant", () => {
    const value = fixture();
    const expected = {
      identity: value.identity,
      planned: value.planned,
      revision: value.revision,
      digest: value.digest,
    };
    expect(
      bindSealedAgentUsageEvidence(bytes(original), expected).evidence.digest,
    ).toBe(value.digest);
    for (const key of Object.keys(value.identity)) {
      const wrong = structuredClone(expected) as typeof expected & {
        identity: Record<string, unknown>;
      };
      wrong.identity[key] = "different";
      expect(() =>
        bindSealedAgentUsageEvidence(bytes(original), wrong),
      ).toThrow(AgentUsageEvidenceError);
    }
    for (const key of Object.keys(value.planned)) {
      const wrong = structuredClone(expected) as typeof expected & {
        planned: Record<string, unknown>;
      };
      wrong.planned[key] = "different";
      expect(() =>
        bindSealedAgentUsageEvidence(bytes(original), wrong),
      ).toThrow(AgentUsageEvidenceError);
    }
    for (const key of ["digest", "revision"] as const) {
      expect(() =>
        bindSealedAgentUsageEvidence(bytes(original), {
          ...expected,
          [key]: "different",
        }),
      ).toThrow(AgentUsageEvidenceError);
    }
    value.execution.seal = false;
    const raw = signed(value);
    expect(decodeAgentUsageEvidence(bytes(raw)).evidence.execution.seal).toBe(
      false,
    );
    expect(() =>
      bindSealedAgentUsageEvidence(bytes(raw), {
        ...expected,
        digest: value.digest,
      }),
    ).toThrow(AgentUsageEvidenceError);
  });
  it.each([
    Buffer.from([0xc0, 0xaf]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(original)]),
    bytes(
      original.replace(
        '"artifact_version":',
        '"artifact_version":"2.0.0","artifact_vers\\u0069on":',
      ),
    ),
    bytes(original.replace('"tenant-example"', '"\\uD800"')),
    bytes(original.replace('"tenant-example"', '"\\u007f"')),
    bytes(original.replace('"tenant-example"', '"\\u000a"')),
    bytes(original.replace('"tenant-example"', "1e999")),
    bytes(original.replace('"tenant-example"', "9007199254740993")),
    bytes(
      original.replace('"tenant-example"', '{"__proto__":{"polluted":true}}'),
    ),
    bytes("[".repeat(17) + "null" + "]".repeat(17)),
    bytes(original + "x"),
    bytes(" ".repeat(65537)),
  ])(
    "rejects malformed/bounded wire input without leaking payload (%#)",
    (raw) => {
      let error: unknown;
      try {
        decodeAgentUsageEvidence(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AgentUsageEvidenceError);
      expect(error).toMatchObject({
        message: "Agent usage evidence is invalid",
        code: "EVIDENCE_INVALID",
      });
      expect(error).not.toHaveProperty("cause");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );
  it("accepts the byte budget boundary and rejects one additional byte", () => {
    const raw = original.padEnd(65536, " ");
    expect(decodeAgentUsageEvidence(bytes(raw)).originalJson).toBe(raw);
    expect(() => decodeAgentUsageEvidence(bytes(raw + " "))).toThrow(
      AgentUsageEvidenceError,
    );
  });
  it("validates distributed and generated owner artifact bytes without repairing drift", async () => {
    await generateAgentUsageArtifacts(root, true);
    const scratch = await mkdtemp(join(tmpdir(), "billing-usage-drift-"));
    try {
      await mkdir(join(scratch, "contract/agent/usage/v2"), {
        recursive: true,
      });
      await cp(
        join(root, "contract/agent/usage/v2/consumer-pin.json"),
        join(scratch, "contract/agent/usage/v2/consumer-pin.json"),
      );
      await cp(join(root, "vendor/agent"), join(scratch, "vendor/agent"), {
        recursive: true,
      });
      await readAgentUsageArtifacts(scratch);
      const http = join(scratch, "vendor/agent/http/v6/openapi.json");
      const originalHttp = await readFile(http);
      await writeFile(http, "{}");
      await expect(readAgentUsageArtifacts(scratch)).rejects.toThrow(
        "differs from accepted release",
      );
      await writeFile(http, originalHttp);
      const path = join(scratch, "vendor/agent/usage/v2/schema.json");
      await writeFile(path, "{}");
      await expect(readAgentUsageArtifacts(scratch)).rejects.toThrow(
        "differs from accepted release",
      );
      expect(await readFile(path, "utf8")).toBe("{}");
      await rm(path);
      await expect(readAgentUsageArtifacts(scratch)).rejects.toThrow();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
  it("bounds nesting including scalar leaves and sorts keys by UTF16, not locale", () => {
    const atLimit = "[".repeat(15) + "null" + "]".repeat(15);
    expect(parseAgentUsageJson(bytes(atLimit)).text).toBe(atLimit);
    expect(() => parseAgentUsageJson(bytes("[" + atLimit + "]"))).toThrow(
      AgentUsageEvidenceError,
    );
    expect(canonicalAgentUsageJson({ "\uE000": "b", "\u{1F600}": "a" })).toBe(
      '{"\u{1F600}":"a","\uE000":"b"}',
    );
    const escaped = JSON.stringify({ quoted: '"\\', ["__proto__"]: null });
    const parsed = parseAgentUsageJson(bytes(escaped));
    expect(Object.getPrototypeOf(parsed.value)).toBeNull();
    expect(canonicalAgentUsageJson(parsed.value)).toBe(
      JSON.stringify({ ["__proto__"]: null, quoted: '"\\' }),
    );
    for (const invalid of [
      '{"a":null,}',
      "[null,]",
      '{"a":true "b":false}',
      '"bad\\q"',
      '"unterminated',
      "true false",
    ])
      expect(() => parseAgentUsageJson(bytes(invalid))).toThrow(
        AgentUsageEvidenceError,
      );
  });
  it("rejects re-signed structural contradictions, not only mismatching digests", () => {
    const mutations: ((value: ModelUsageEvidence) => void)[] = [
      (value) => {
        value.revision = "2";
      },
      (value) => {
        value.revision = "2";
        value.predecessor = {
          event_id: value.identity.event_id,
          digest: "a".repeat(64),
        };
      },
      (value) => {
        value.execution.outcome = "not_dispatched";
      },
      (value) => {
        value.execution.dispatch_started_at = null;
      },
      (value) => {
        value.authorization_observation = { state: "not_requested" };
      },
      (value) => {
        value.execution.prepared_at = "0000-01-01T00:00:00.000Z";
      },
    ];
    for (const mutate of mutations) {
      const value = fixture();
      mutate(value);
      expect(() => decodeAgentUsageEvidence(bytes(signed(value)))).toThrow(
        AgentUsageEvidenceError,
      );
    }
  });
});

const expectedUsage = () => {
  const value = fixture();
  return {
    identity: value.identity,
    planned: value.planned,
    revision: value.revision,
    digest: value.digest,
  };
};
const envelope = () => {
  const value = fixture();
  return {
    data: {
      artifact_version: "2.0.0",
      attempt_id: value.identity.attempt_id,
      event_id: value.identity.event_id,
      revision: value.revision,
      evidence_bytes_base64url: Buffer.from(original).toString("base64url"),
      evidence_digest: value.digest,
      sealed: true,
      observed_at: "2026-10-03T12:34:56.000Z",
    },
    meta: { request_id: "reader-test" },
  };
};
const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-request-id": "reader-test",
};
async function withEvidenceServer(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
  check: (
    reader: AgentUsageEvidenceReader,
    count: () => number,
  ) => Promise<void>,
  deadlineMs = 2000,
) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    respond(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No HTTP fixture port");
  const reader = new AgentUsageEvidenceReader({
    baseUrl: `http://127.0.0.1:${address.port}`,
    machineBearerToken: "reader-secret-canary",
    deadlineMs,
  });
  try {
    await check(reader, () => requests);
  } finally {
    await reader.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
const readEvidence = (
  reader: AgentUsageEvidenceReader,
  signal = new AbortController().signal,
) =>
  reader.read({ expected: expectedUsage(), requestId: "reader-test", signal });

describe("Agent HTTP6 exact usage2 evidence reader", () => {
  it("uses only its dedicated service context and returns exact immutable owner bytes", async () => {
    await withEvidenceServer(
      (request, response) => {
        const identity = fixture().identity;
        expect(request.method).toBe("GET");
        expect(request.url).toBe(
          `/v1/model-call-attempts/${identity.attempt_id}/usage-evidence/${identity.event_id}`,
        );
        expect(request.headers.authorization).toBe(
          "Bearer reader-secret-canary",
        );
        expect(request.headers["x-kokoro-tenant-ref"]).toBe(
          identity.tenant_ref,
        );
        expect(request.headers["x-request-id"]).toBe("reader-test");
        expect(request.headers["x-kokoro-actor-ref"]).toBeUndefined();
        response
          .writeHead(200, responseHeaders)
          .end(JSON.stringify(envelope()));
      },
      async (reader, count) => {
        const expected = expectedUsage();
        const pending = reader.read({
          expected,
          requestId: "reader-test",
          signal: new AbortController().signal,
        });
        expected.identity.tenant_ref = "caller-mutated-after-read";
        expected.planned.provider = "caller-mutated-provider";
        const result = await pending;
        expect(result.originalJson).toBe(original);
        expect(Object.isFrozen(result.evidence.planned)).toBe(true);
        expect(result.evidence.identity.tenant_ref).toBe("tenant-example");
        expect(count()).toBe(1);
        expect(JSON.stringify(reader)).not.toContain("reader-secret-canary");
      },
    );
  });

  it.each([
    [
      "legacy version",
      (v: ReturnType<typeof envelope>) => {
        v.data.artifact_version = "1.0.0";
      },
    ],
    [
      "wrong attempt",
      (v: ReturnType<typeof envelope>) => {
        v.data.attempt_id = "00000000-0000-4000-8000-000000000099";
      },
    ],
    [
      "wrong event",
      (v: ReturnType<typeof envelope>) => {
        v.data.event_id = "00000000-0000-4000-8000-000000000099";
      },
    ],
    [
      "wrong revision",
      (v: ReturnType<typeof envelope>) => {
        v.data.revision = "2";
      },
    ],
    [
      "wrong digest",
      (v: ReturnType<typeof envelope>) => {
        v.data.evidence_digest = "0".repeat(64);
      },
    ],
    [
      "unsealed",
      (v: ReturnType<typeof envelope>) => {
        v.data.sealed = false;
      },
    ],
    [
      "wrong correlation",
      (v: ReturnType<typeof envelope>) => {
        v.meta.request_id = "wrong";
      },
    ],
    [
      "invalid time",
      (v: ReturnType<typeof envelope>) => {
        v.data.observed_at = "2026-02-30T00:00:00.000Z";
      },
    ],
    [
      "base64 padding",
      (v: ReturnType<typeof envelope>) => {
        v.data.evidence_bytes_base64url += "=";
      },
    ],
    [
      "bad nested bytes",
      (v: ReturnType<typeof envelope>) => {
        v.data.evidence_bytes_base64url =
          Buffer.from("{}").toString("base64url");
      },
    ],
    [
      "extra field",
      (v: ReturnType<typeof envelope>) => {
        Object.assign(v.data, { extra: "UPSTREAM_SECRET" });
      },
    ],
  ] as const)(
    "rejects %s without retry or payload leakage",
    async (_name, mutate) => {
      const value = envelope();
      mutate(value);
      await withEvidenceServer(
        (_request, response) =>
          response.writeHead(200, responseHeaders).end(JSON.stringify(value)),
        async (reader, count) => {
          const error = await readEvidence(reader).catch(
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(AgentUsageReaderError);
          expect(error).toMatchObject({ code: "CONTRACT_INVALID" });
          expect(JSON.stringify(error)).not.toContain("UPSTREAM_SECRET");
          expect(error).not.toHaveProperty("cause");
          expect(count()).toBe(1);
        },
      );
    },
  );

  it("keeps the wrapper and evidence budgets separate and rejects noncanonical base64 bits", async () => {
    let attempt = 0;
    const raw = original.padEnd(65536, " ");
    await withEvidenceServer(
      (_request, response) => {
        attempt++;
        const value = envelope();
        let encoded = Buffer.from(attempt === 2 ? raw + " " : raw).toString(
          "base64url",
        );
        if (attempt === 3) {
          const alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
          const last = encoded.at(-1);
          if (!last) throw new Error("Missing base64 test input");
          encoded = encoded.slice(0, -1) + alphabet[alphabet.indexOf(last) | 1];
          expect(Buffer.from(encoded, "base64url").toString()).toBe(raw);
        }
        value.data.evidence_bytes_base64url = encoded;
        response.writeHead(200, responseHeaders).end(JSON.stringify(value));
      },
      async (reader) => {
        expect((await readEvidence(reader)).originalJson).toBe(raw);
        await expect(readEvidence(reader)).rejects.toMatchObject({
          code: "CONTRACT_INVALID",
        });
        await expect(readEvidence(reader)).rejects.toMatchObject({
          code: "CONTRACT_INVALID",
        });
      },
    );
  });

  it("binds the complete durable planned and identity snapshot, not only the URI", async () => {
    await withEvidenceServer(
      (_request, response) =>
        response
          .writeHead(200, responseHeaders)
          .end(JSON.stringify(envelope())),
      async (reader) => {
        for (const mutate of [
          (v: ReturnType<typeof expectedUsage>) => {
            v.planned.provider = "other";
          },
          (v: ReturnType<typeof expectedUsage>) => {
            v.identity.actor.opaque_ref = "other";
          },
          (v: ReturnType<typeof expectedUsage>) => {
            v.identity.lease.generation = "2";
          },
        ]) {
          const expected = expectedUsage();
          mutate(expected);
          await expect(
            reader.read({
              expected,
              requestId: "reader-test",
              signal: new AbortController().signal,
            }),
          ).rejects.toMatchObject({ code: "CONTRACT_INVALID" });
        }
      },
    );
  });

  it.each([
    ["metadata", "{}", { ...responseHeaders, "x-request-id": "other" }],
    ["cache", "{}", { ...responseHeaders, "cache-control": "public" }],
    ["media", "{}", { ...responseHeaders, "content-type": "text/plain" }],
    [
      "oversize header",
      "{}",
      {
        ...responseHeaders,
        "content-length": String(MAX_AGENT_EVIDENCE_RESPONSE_BYTES + 1),
      },
    ],
    [
      "oversize stream",
      " ".repeat(MAX_AGENT_EVIDENCE_RESPONSE_BYTES + 1),
      responseHeaders,
    ],
    ["invalid UTF8", Buffer.from([0xc0, 0xaf]), responseHeaders],
    ["duplicate key", '{"data":{},"data":{}}', responseHeaders],
  ] as const)(
    "rejects %s at the bounded HTTP boundary",
    async (_name, body, headers) => {
      await withEvidenceServer(
        (_request, response) => {
          response.writeHead(200, headers);
          response.write(body);
          response.end();
        },
        async (reader) => {
          await expect(readEvidence(reader)).rejects.toMatchObject({
            code: "CONTRACT_INVALID",
          });
        },
      );
    },
  );

  it.each([
    [401, "DENIED"],
    [403, "DENIED"],
    [404, "NOT_FOUND"],
    [503, "UNAVAILABLE"],
    [302, "UNAVAILABLE"],
  ] as const)(
    "never retries or treats HTTP %s as evidence/zero usage",
    async (status, code) => {
      await withEvidenceServer(
        (_request, response) =>
          response
            .writeHead(status, { location: "/redirect-must-not-be-followed" })
            .end("UPSTREAM_SECRET"),
        async (reader, count) => {
          await expect(readEvidence(reader)).rejects.toMatchObject({ code });
          expect(count()).toBe(1);
        },
      );
    },
  );

  it("covers the body under the same deadline and cancels inflight reads on caller/shutdown", async () => {
    await withEvidenceServer(
      (_request, response) => {
        response.writeHead(200, responseHeaders);
        response.write("{");
      },
      async (reader) => {
        await expect(readEvidence(reader)).rejects.toMatchObject({
          code: "TIMEOUT",
        });
      },
      100,
    );
    for (const shutdown of [false, true]) {
      let resolveReceived: () => void = () => undefined;
      const received = new Promise<void>((resolve) => {
        resolveReceived = resolve;
      });
      await withEvidenceServer(
        (_request, response) => {
          response.writeHead(200, responseHeaders);
          response.write("{");
          resolveReceived();
        },
        async (reader) => {
          const controller = new AbortController();
          const pending = expect(
            readEvidence(reader, controller.signal),
          ).rejects.toMatchObject({
            code: shutdown ? "SHUTTING_DOWN" : "ABORTED",
          });
          await received;
          if (shutdown) await reader.onModuleDestroy();
          else controller.abort();
          await pending;
          if (shutdown)
            await expect(readEvidence(reader)).rejects.toMatchObject({
              code: "SHUTTING_DOWN",
            });
        },
      );
    }
  });

  it("rejects invalid local context before network and keeps configured credentials non-enumerable", async () => {
    const options = resolveAgentUsageReaderOptions({
      baseUrl: "http://localhost/",
      machineBearerToken: "reader-secret-canary",
      deadlineMs: 1,
    });
    expect(options.baseUrl).toBe("http://localhost");
    expect(JSON.stringify(options)).not.toContain("reader-secret-canary");
    expect(() =>
      resolveAgentUsageReaderOptions({
        ...options,
        baseUrl: "https://user:URL_SECRET@example.com/",
        machineBearerToken: "reader-secret-canary",
      }),
    ).toThrow(AgentUsageReaderError);
    await withEvidenceServer(
      (_request, response) => response.end("unexpected"),
      async (reader, count) => {
        const expected = expectedUsage();
        expected.identity.attempt_id = "../escape";
        await expect(
          reader.read({
            expected,
            requestId: "reader-test",
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
        const controller = new AbortController();
        controller.abort();
        await expect(
          readEvidence(reader, controller.signal),
        ).rejects.toMatchObject({ code: "ABORTED" });
        expect(count()).toBe(0);
      },
    );
  });
});
