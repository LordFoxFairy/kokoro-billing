import { createServer } from "node:http";
import { expect, it } from "vitest";
import { AgentUsageEvidenceReader } from "../../src/modules/metering/agent-usage-evidence-reader.js";

it("reads the bound operation and distinguishes the owner stale response", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response
      .writeHead(409, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-request-id": "bound-test",
      })
      .end(
        JSON.stringify({
          error: { code: "model_call_bound_stale", message: "stale" },
          meta: { request_id: "bound-test" },
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing fixture port");
  const reader = new AgentUsageEvidenceReader({
    baseUrl: `http://127.0.0.1:${address.port}`,
    machineBearerToken: "reader-secret-canary",
    deadlineMs: 2000,
  });
  try {
    const readBound: unknown = Reflect.get(reader, "readBound");
    expect(
      readBound,
      "the same reader must consume the published bound operation",
    ).toBeTypeOf("function");
    if (typeof readBound !== "function")
      throw new Error("bound operation is missing");
    await expect(
      readBound.call(reader, {
        expected: {
          tenantRef: "tenant-a",
          producer: "kokoro-agent",
          runId: "run-a",
          callId: "11111111-1111-4111-8111-111111111111",
          attemptId: "22222222-2222-5222-8222-222222222222",
          attemptOrdinal: "1",
          featureKey: "chat",
          plannedBindingRef: "mpb_22222222-2222-5222-8222-222222222222",
          plannedBindingDigest: "a".repeat(64),
          usageProfileVersion: "2.0.0",
          usageProfileDigest:
            "552f0d22251837aaf4d83766c7bd91311984f707f9a42950ed53ac7127bb5504",
          executionBoundRef: "mcb_22222222-2222-5222-8222-222222222222",
          executionBoundDigest: "b".repeat(64),
        },
        requestId: "bound-test",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "STALE" });
    expect(requests).toBe(1);
  } finally {
    await reader.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import {
  readFile,
  mkdtemp,
  cp,
  mkdir,
  writeFile,
  rename,
  symlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe } from "vitest";
import { z } from "zod";
import type { AgentModelCallBound } from "../../src/generated/agent-model-call-bound-v1/index.js";
import type {
  PlannedBinding,
  ModelUsageEvidence,
} from "../../src/generated/agent-usage-v2/types.gen.js";
import { agentModelCallBoundSchema } from "../../src/generated/agent-model-call-bound-v1/schema.gen.js";
import {
  agentCapacityGuarantee,
  agentCapacityManifest,
} from "../../src/generated/agent-model-call-bound-v1/capacity-guarantee.gen.js";
import { SOURCE_SHA256 } from "../../src/generated/agent-usage-v2/schema.gen.js";
import { decodeAgentModelCallBound } from "../../src/modules/metering/agent-model-call-bound.js";
import type { ExpectedAgentModelCallBound } from "../../src/modules/metering/agent-model-call-bound.js";
import { AgentModelCallBoundError } from "../../src/modules/metering/agent-model-call-bound.error.js";
import { AgentUsageReaderError } from "../../src/modules/metering/agent-usage-evidence-reader.error.js";
import { createAgentModelCallValidator } from "../../src/modules/metering/agent-model-call-validation.js";
import {
  parseAgentBoundJson,
  parseAgentBoundEnvelopeJson,
  parseAgentUsageJson,
} from "../../src/modules/metering/agent-usage-json.js";
import {
  readAgentUsageArtifacts,
  generateAgentUsageArtifacts,
} from "../../scripts/generate-agent-usage.js";

const root = resolve(import.meta.dirname, "../..");
const published = z
  .object({ valid: z.array(z.unknown()), invalid: z.array(z.unknown()) })
  .parse(
    JSON.parse(
      await readFile(
        join(root, "vendor/agent/model-call-bound/v1/vectors.json"),
        "utf8",
      ),
    ),
  );
const usageVectors = z
  .object({ positive: z.array(z.object({ json_utf8: z.string() })) })
  .parse(
    JSON.parse(
      await readFile(join(root, "vendor/agent/usage/v2/vectors.json"), "utf8"),
    ),
  );
const usageText = usageVectors.positive[0]?.json_utf8;
if (!usageText || !published.valid[0]) throw new Error("owner vector missing");
const usage = JSON.parse(usageText) as ModelUsageEvidence;
const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
// Test encoder is independent of the production parser/canonicalizer.
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function material() {
  const planned: PlannedBinding = {
    ...usage.planned,
    request_model: "gpt-4o-2024-08-06",
    provider_model_name: "gpt-4o-2024-08-06",
  };
  const bound = structuredClone(published.valid[0]) as AgentModelCallBound;
  bound.sealed_at = new Date(Date.now() - 1000).toISOString();
  bound.valid_until = new Date(Date.now() + 60_000).toISOString();
  return { planned, bound };
}
function wire(m = material()) {
  const plannedText = canonical(m.planned);
  m.bound.planned_binding_digest = sha(plannedText);
  const boundText = canonical(m.bound);
  const expected: ExpectedAgentModelCallBound = {
    tenantRef: m.bound.tenant_ref,
    producer: "kokoro-agent",
    runId: m.bound.run_id,
    callId: m.bound.call_id,
    attemptId: m.bound.attempt_id,
    attemptOrdinal: m.bound.attempt_ordinal,
    featureKey: m.planned.feature_key,
    plannedBindingRef: m.bound.planned_binding_ref,
    plannedBindingDigest: sha(plannedText),
    usageProfileVersion: "2.0.0",
    usageProfileDigest: SOURCE_SHA256,
    executionBoundRef: m.bound.execution_bound_ref,
    executionBoundDigest: sha(boundText),
  };
  return {
    plannedText,
    boundText,
    expected,
    body: {
      data: {
        planned_binding_ref: expected.plannedBindingRef,
        planned_binding_digest: expected.plannedBindingDigest,
        planned_binding_bytes_base64url:
          Buffer.from(plannedText).toString("base64url"),
        execution_bound_ref: expected.executionBoundRef,
        execution_bound_digest: expected.executionBoundDigest,
        execution_bound_artifact_version: "1.0.0",
        execution_bound_revision: "1",
        execution_bound_bytes_base64url:
          Buffer.from(boundText).toString("base64url"),
      },
      meta: { request_id: "bound-test" },
    },
  };
}
function decode(w = wire(), now = Date.now()) {
  return decodeAgentModelCallBound({
    plannedRaw: Buffer.from(w.plannedText),
    boundRaw: Buffer.from(w.boundText),
    expected: w.expected,
    now,
  });
}
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-request-id": "bound-test",
};
async function withServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
  check: (
    reader: AgentUsageEvidenceReader,
    count: () => number,
  ) => Promise<void>,
  deadlineMs = 2000,
) {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    respond(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port missing");
  const reader = new AgentUsageEvidenceReader({
    baseUrl: `http://127.0.0.1:${address.port}`,
    machineBearerToken: "bound-secret-canary",
    deadlineMs,
  });
  try {
    await check(reader, () => count);
  } finally {
    await reader.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const read = (
  reader: AgentUsageEvidenceReader,
  w = wire(),
  signal = new AbortController().signal,
) =>
  reader.readBound({ expected: w.expected, requestId: "bound-test", signal });

it("checks every published bound schema vector without rewriting its facts", () => {
  const validate = createAgentModelCallValidator().compile(
    agentModelCallBoundSchema,
  );
  for (const value of published.valid) expect(validate(value)).toBe(true);
  for (const value of published.invalid) expect(validate(value)).toBe(false);
});
it("checks capacity release vectors and its exact canonical guarantee digest", async () => {
  const schema = JSON.parse(
    await readFile(
      join(root, "vendor/agent/model-call-capacity-guarantee/v1/schema.json"),
      "utf8",
    ),
  ) as object;
  const vectors = z
    .object({
      valid: z.array(z.object({ name: z.string(), value: z.unknown() })),
      invalid: z.array(
        z.object({ name: z.string(), mutation: z.record(z.unknown()) }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(
            root,
            "vendor/agent/model-call-capacity-guarantee/v1/vectors.json",
          ),
          "utf8",
        ),
      ),
    );
  const validate = createAgentModelCallValidator().compile(schema);
  for (const row of vectors.valid)
    expect(validate(row.value), row.name).toBe(true);
  for (const row of vectors.invalid)
    expect(
      validate({ ...agentCapacityGuarantee, ...row.mutation }),
      row.name,
    ).toBe(false);
  expect(sha(canonical(agentCapacityGuarantee))).toBe(
    agentCapacityManifest.guarantee_sha256,
  );
});
it("preserves two original canonical strings and recursively freezes both facts", () => {
  const m = material();
  m.planned.label = "😀\uE000e\u0301";
  m.bound.attempt_ordinal = "9223372036854775807";
  m.bound.lease_generation = "9223372036854775807";
  const w = wire(m),
    result = decode(w);
  expect(result.originalPlannedJson).toBe(w.plannedText);
  expect(result.originalBoundJson).toBe(w.boundText);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.planned)).toBe(true);
  expect(Object.isFrozen(result.bound.system_provenance)).toBe(true);
  expect(Object.isFrozen(result.bound.system_provenance.source_sha256)).toBe(
    true,
  );
  expect(() =>
    Object.assign(result.bound.joint_constraints, { 0: "changed" }),
  ).toThrow();
});
it.each([
  "1.0",
  "1e0",
  "1E+0",
  "true",
  "false",
  "null",
  '"1"',
  "0",
  "2",
  "-1",
  "01",
  "1e999",
])(
  "rejects numeric lexical alias %s even when caller digest matches",
  (token) => {
    const w = wire();
    w.boundText = w.boundText.replace(
      '"final_request_binding_version":1',
      `"final_request_binding_version":${token}`,
    );
    w.expected = { ...w.expected, executionBoundDigest: sha(w.boundText) };
    expect(() => decode(w)).toThrow(AgentModelCallBoundError);
  },
);
it("allows integer one only at the bound root field, with usage/envelope still number-free", () => {
  expect(
    parseAgentBoundJson(Buffer.from('{"final_request_binding_version":1}'))
      .value,
  ).toEqual({ final_request_binding_version: 1 });
  for (const text of [
    "1",
    '{"other":1}',
    '{"nested":{"final_request_binding_version":1}}',
    '{"final_request_binding_version":[1]}',
  ])
    expect(() => parseAgentBoundJson(Buffer.from(text))).toThrow();
  for (const parser of [parseAgentUsageJson, parseAgentBoundEnvelopeJson])
    expect(() =>
      parser(Buffer.from('{"final_request_binding_version":1}')),
    ).toThrow();
});
it.each([
  ["extra", true],
  ["revision", "2"],
  ["sealed", false],
  ["attempt_id", "00000000-0000-4000-8000-000000000001"],
  ["attempt_ordinal", "9223372036854775808"],
  ["lease_generation", "0"],
  ["lease_owner", "😀".repeat(129)],
  ["total_tokens_max", "128001"],
  ["output_tokens_max", "16385"],
  ["output_tokens_max", "0"],
  ["output_tokens_max", "01"],
  ["capacity_guarantee_digest", "f".repeat(64)],
  ["capacity_guarantee_id", "other"],
  ["profile_id", "deepagents_tools"],
  ["request_profile", "streaming"],
  ["final_request_digest", "f".repeat(63)],
  ["unit", "dollar"],
  ["joint_constraints", ["total=P"]],
  ["sealed_at", "2026-02-30T00:00:00.000Z"],
  ["sealed_at", "2026-10-23T00:00:00Z"],
  ["valid_until", "2027-01-14T00:00:00.001Z"],
  ["valid_until", "2026-10-23T08:00:00.000+08:00"],
  ["producer", "caller"],
] as const)("rejects closed bound field %s=%s", (key, value) => {
  const m = material();
  Object.assign(m.bound, { [key]: value });
  expect(() => decode(wire(m))).toThrow(AgentModelCallBoundError);
});
it.each([
  "request_model",
  "provider_model_name",
  "binding_version",
  "revision",
  "generation",
  "tenant_generation",
] as const)("rejects invalid planned %s", (key) => {
  const m = material();
  Object.assign(m.planned, { [key]: "unsupported" });
  expect(() => decode(wire(m))).toThrow(AgentModelCallBoundError);
});
it("checks all thirteen independent expected fields", () => {
  for (const key of Object.keys(wire().expected)) {
    const w = wire();
    w.expected = { ...w.expected, [key]: "different" };
    expect(() => decode(w), key).toThrow(AgentModelCallBoundError);
  }
});
it("requires all eight provenance keys and all twenty exact source digests", () => {
  const keys = Object.keys(material().bound.system_provenance);
  expect(keys).toHaveLength(8);
  for (const key of keys) {
    const m = material();
    delete m.bound.system_provenance[key];
    expect(() => decode(wire(m)), key).toThrow();
  }
  const sources = z
    .record(z.string())
    .parse(material().bound.system_provenance.source_sha256);
  expect(Object.keys(sources)).toHaveLength(20);
  for (const key of Object.keys(sources)) {
    const m = material();
    m.bound.system_provenance.source_sha256 = {
      ...sources,
      [key]: "0".repeat(64),
    };
    expect(() => decode(wire(m)), key).toThrow();
  }
  const m = material();
  m.bound.system_provenance.extra = true;
  expect(() => decode(wire(m))).toThrow();
});
it("checks exact seal/expiry/response-time joint boundaries", () => {
  const m = material();
  m.bound.sealed_at = "2026-10-23T00:00:00.000Z";
  m.bound.valid_until = "2027-01-14T00:00:00.000Z";
  const w = wire(m),
    seal = Date.parse(m.bound.sealed_at),
    expiry = Date.parse(m.bound.valid_until);
  expect(() => decode(w, seal)).not.toThrow();
  expect(() => decode(w, expiry - 1)).not.toThrow();
  for (const now of [seal - 1, expiry, expiry + 1, NaN])
    expect(() => decode(w, now)).toThrow();
  m.bound.valid_until = m.bound.sealed_at;
  expect(() => decode(wire(m), seal)).toThrow();
});
it("rejects invalid bytes, duplicate decoded names, noncanonical, depth and prototype pollution", () => {
  const w = wire();
  const invalid = [
    Buffer.from([0xc3, 0x28]),
    Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(w.boundText)]),
    Buffer.from(w.boundText + " "),
    Buffer.from(w.boundText.replace("{", '{"producer":"kokoro-agent",')),
    Buffer.from(w.boundText.replace("{", '{"produc\\u0065r":"kokoro-agent",')),
    Buffer.from('{"__proto__":{"polluted":true}}'),
    Buffer.from("[".repeat(17) + "null" + "]".repeat(17)),
    Buffer.from('{"name":"\\ud800"}'),
    Buffer.from('{"name":"\\u007f"}'),
    Buffer.alloc(65537, 32),
  ];
  for (const boundRaw of invalid)
    expect(() =>
      decodeAgentModelCallBound({
        plannedRaw: Buffer.from(w.plannedText),
        boundRaw,
        expected: { ...w.expected, executionBoundDigest: sha(boundRaw) },
        now: Date.now(),
      }),
    ).toThrow(AgentModelCallBoundError);
  for (const plannedRaw of [
    Buffer.from(w.plannedText + " "),
    Buffer.alloc(65537, 32),
    Buffer.from('{"label":"\\udfff"}'),
  ])
    expect(() =>
      decodeAgentModelCallBound({
        plannedRaw,
        boundRaw: Buffer.from(w.boundText),
        expected: { ...w.expected, plannedBindingDigest: sha(plannedRaw) },
        now: Date.now(),
      }),
    ).toThrow();
  expect(Object.hasOwn({}, "polluted")).toBe(false);
});

describe("bound loopback HTTP transport", () => {
  it("uses the exact endpoint and trusted headers, then preserves owner bytes", async () => {
    const w = wire();
    await withServer(
      (req, res) => {
        expect(req.url).toBe(
          `/v1/model-call-bounds/${w.expected.executionBoundRef}`,
        );
        expect(req.method).toBe("GET");
        expect(req.headers.authorization).toBe("Bearer bound-secret-canary");
        expect(req.headers["x-kokoro-tenant-ref"]).toBe(w.expected.tenantRef);
        expect(req.headers["x-request-id"]).toBe("bound-test");
        res.writeHead(200, headers).end(JSON.stringify(w.body));
      },
      async (reader, count) => {
        const result = await read(reader, w);
        expect(result.originalBoundJson).toBe(w.boundText);
        expect(result.originalPlannedJson).toBe(w.plannedText);
        expect(count()).toBe(1);
      },
    );
  });
  it.each([
    [401, "agent_reader_auth_failed", "DENIED"],
    [403, "agent_reader_forbidden", "DENIED"],
    [404, "model_call_bound_not_found", "NOT_FOUND"],
    [409, "model_call_bound_stale", "STALE"],
    [410, "model_call_bound_expired", "EXPIRED"],
    [503, "agent_reader_unavailable", "UNAVAILABLE"],
  ] as const)(
    "accepts only the exact %s error envelope and never retries",
    async (status, code, result) => {
      await withServer(
        (_req, res) =>
          res.writeHead(status, headers).end(
            JSON.stringify({
              error: { code, message: "bound-secret-canary" },
              meta: { request_id: "bound-test" },
            }),
          ),
        async (reader, count) => {
          const error: unknown = await read(reader).catch(
            (error: unknown) => error,
          );
          expect(error).toBeInstanceOf(AgentUsageReaderError);
          expect(error).toMatchObject({ code: result });
          expect(String(error)).not.toContain("bound-secret-canary");
          expect(error).not.toHaveProperty("cause");
          expect(count()).toBe(1);
        },
      );
    },
  );
  it.each([
    "status-code",
    "error-meta",
    "error-extra",
    "success-meta",
    "header-request",
    "cache",
    "type",
    "envelope-extra",
    "version",
    "revision",
    "base64-padding",
    "base64-alias",
    "planned-digest",
    "bound-digest",
    "duplicate",
    "utf8",
    "number",
  ])("rejects %s", async (name) => {
    const w = wire();
    let status = 200,
      body: string | Buffer = JSON.stringify(w.body);
    const h = { ...headers };
    if (name.startsWith("error") || name === "status-code") {
      status = 409;
      body = JSON.stringify({
        error: {
          code:
            name === "status-code"
              ? "model_call_bound_expired"
              : "model_call_bound_stale",
          message: "secret",
          ...(name === "error-extra" ? { extra: true } : {}),
        },
        meta: { request_id: name === "error-meta" ? "wrong" : "bound-test" },
      });
    }
    if (name === "success-meta")
      body = body.toString().replace("bound-test", "wrong");
    if (name === "header-request") h["x-request-id"] = "wrong";
    if (name === "cache") h["cache-control"] = "public";
    if (name === "type") h["content-type"] = "text/html";
    if (name === "envelope-extra")
      body = body.toString().replace("{", '{"extra":true,');
    if (name === "version")
      w.body.data.execution_bound_artifact_version = "2.0.0";
    if (name === "revision") w.body.data.execution_bound_revision = "2";
    if (name === "base64-padding")
      w.body.data.execution_bound_bytes_base64url += "=";
    if (name === "base64-alias") {
      const raw = Buffer.from(w.boundText + " ");
      const encoded = raw.toString("base64url");
      w.body.data.execution_bound_bytes_base64url = encoded.slice(0, -1) + "_";
    }
    if (name === "planned-digest")
      w.body.data.planned_binding_digest = "0".repeat(64);
    if (name === "bound-digest")
      w.body.data.execution_bound_digest = "0".repeat(64);
    if (
      [
        "version",
        "revision",
        "base64-padding",
        "base64-alias",
        "planned-digest",
        "bound-digest",
      ].includes(name)
    )
      body = JSON.stringify(w.body);
    if (name === "duplicate")
      body = body.toString().replace("{", '{"data":{},');
    if (name === "utf8") body = Buffer.from([0xc3, 0x28]);
    if (name === "number")
      body = body.toString().replace('"meta":', '"other":1,"meta":');
    await withServer(
      (_req, res) => res.writeHead(status, h).end(body),
      async (reader) => {
        await expect(read(reader, w)).rejects.toMatchObject({
          code: "CONTRACT_INVALID",
        });
      },
    );
  });
  it("accepts a valid whitespace envelope above 98304 through the full 196608 budget", async () => {
    const w = wire(),
      body = JSON.stringify(w.body).padEnd(196608, " ");
    await withServer(
      (_req, res) => res.writeHead(200, headers).end(body),
      async (reader) => {
        expect((await read(reader, w)).originalBoundJson).toBe(w.boundText);
      },
    );
  });
  it.each(["length", "chunks"] as const)(
    "rejects outer oversize by %s",
    async (mode) => {
      const w = wire(),
        body = JSON.stringify(w.body).padEnd(196609, " ");
      await withServer(
        (_req, res) => {
          res.writeHead(200, {
            ...headers,
            ...(mode === "length"
              ? { "content-length": String(body.length) }
              : {}),
          });
          if (mode === "chunks") {
            res.write(body.slice(0, 98304));
            res.end(body.slice(98304));
          } else res.end(body);
        },
        async (reader) => {
          await expect(read(reader, w)).rejects.toMatchObject({
            code: "CONTRACT_INVALID",
          });
        },
      );
    },
  );
  it.each(["headers", "body"] as const)(
    "applies the same total deadline to slow %s",
    async (phase) => {
      await withServer(
        (_req, res) => {
          if (phase === "body") {
            res.writeHead(200, headers);
            res.write("{");
          }
        },
        async (reader) => {
          await expect(read(reader)).rejects.toMatchObject({ code: "TIMEOUT" });
        },
        50,
      );
    },
  );
  it("rejects a bound that expires while its response body is in flight", async () => {
    const m = material();
    m.bound.valid_until = new Date(Date.now() + 100).toISOString();
    const w = wire(m);
    await withServer(
      (_req, res) => {
        res.writeHead(200, headers);
        res.write(" ");
        const timer = setTimeout(() => res.end(JSON.stringify(w.body)), 150);
        res.once("close", () => clearTimeout(timer));
      },
      async (reader) => {
        await expect(read(reader, w)).rejects.toMatchObject({
          code: "CONTRACT_INVALID",
        });
      },
    );
  });
  it("clones the entire trusted expected before network suspension", async () => {
    const w = wire();
    await withServer(
      (_req, res) => res.writeHead(200, headers).end(JSON.stringify(w.body)),
      async (reader) => {
        const promise = read(reader, w);
        for (const key of Object.keys(w.expected))
          Object.assign(w.expected, { [key]: "mutated" });
        expect((await promise).originalBoundJson).toBe(w.boundText);
      },
    );
  });
  it("cancels live reads and drains mixed usage/bound requests on shutdown", async () => {
    let ready: () => void = () => {};
    const received = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let arrivals = 0;
    await withServer(
      (_req, res) => {
        res.writeHead(200, headers);
        res.write(" ");
        if (++arrivals === 3) ready();
      },
      async (reader, count) => {
        const controller = new AbortController();
        const bound = read(reader).catch((e: unknown) => e);
        const cancel = read(reader, wire(), controller.signal).catch(
          (e: unknown) => e,
        );
        const legacy = reader
          .read({
            expected: {
              identity: usage.identity,
              planned: usage.planned,
              revision: usage.revision,
              digest: usage.digest,
            },
            requestId: "bound-test",
            signal: new AbortController().signal,
          })
          .catch((e: unknown) => e);
        await received;
        controller.abort();
        expect(await cancel).toMatchObject({ code: "ABORTED" });
        await reader.onModuleDestroy();
        expect(await bound).toMatchObject({ code: "SHUTTING_DOWN" });
        expect(await legacy).toMatchObject({ code: "SHUTTING_DOWN" });
        await expect(read(reader)).rejects.toMatchObject({
          code: "SHUTTING_DOWN",
        });
        expect(count()).toBe(3);
      },
    );
  });
  it("rejects aborted and malformed input before any network request", async () => {
    await withServer(
      (_req, res) => res.end(),
      async (reader, count) => {
        const controller = new AbortController();
        controller.abort();
        await expect(
          read(reader, wire(), controller.signal),
        ).rejects.toMatchObject({ code: "ABORTED" });
        for (const requestId of [
          "a".repeat(129),
          "bad request",
          "bad\r\nheader",
        ])
          await expect(
            reader.readBound({
              expected: wire().expected,
              requestId,
              signal: new AbortController().signal,
            }),
          ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
        const w = wire();
        Object.assign(w.expected, { extra: "value" });
        await expect(read(reader, w)).rejects.toMatchObject({
          code: "REQUEST_INVALID",
        });
        expect(count()).toBe(0);
      },
    );
  });
  it("does not follow redirects or retry dependency failures", async () => {
    await withServer(
      (_req, res) => res.writeHead(302, { location: "/secret-canary" }).end(),
      async (reader, count) => {
        await expect(read(reader)).rejects.toMatchObject({
          code: "UNAVAILABLE",
        });
        expect(count()).toBe(1);
      },
    );
  });
});

it("detects all bound and capacity artifact corruption via the single accepted pin", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "billing-bound-artifacts-"));
  try {
    await mkdir(join(scratch, "contract/agent/usage/v2"), { recursive: true });
    await cp(
      join(root, "contract/agent/usage/v2/consumer-pin.json"),
      join(scratch, "contract/agent/usage/v2/consumer-pin.json"),
    );
    await cp(join(root, "vendor/agent"), join(scratch, "vendor/agent"), {
      recursive: true,
    });
    await expect(readAgentUsageArtifacts(scratch)).resolves.toBeDefined();
    for (const folder of ["model-call-bound", "model-call-capacity-guarantee"])
      for (const name of folder === "model-call-bound"
        ? ["schema", "vectors", "manifest"]
        : ["schema", "guarantee", "evidence", "vectors", "manifest"]) {
        const path = join(scratch, `vendor/agent/${folder}/v1/${name}.json`),
          original = await readFile(path);
        await writeFile(path, Buffer.concat([original, Buffer.from(" ")]));
        await expect(readAgentUsageArtifacts(scratch)).rejects.toThrow(
          "differs from accepted release",
        );
        await writeFile(path, original);
      }
    await expect(
      generateAgentUsageArtifacts(root, true),
    ).resolves.toBeUndefined();
  } finally {
    await rename(scratch, join(homedir(), ".Trash", basename(scratch)));
  }
});

it("checks all six generated outputs for drift without rewriting them", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "billing-bound-generated-"));
  try {
    await cp(join(root, "contract/agent"), join(scratch, "contract/agent"), {
      recursive: true,
    });
    await cp(join(root, "vendor/agent"), join(scratch, "vendor/agent"), {
      recursive: true,
    });
    await cp(
      join(root, "src/generated/agent-usage-v2"),
      join(scratch, "src/generated/agent-usage-v2"),
      { recursive: true },
    );
    await cp(
      join(root, "src/generated/agent-model-call-bound-v1"),
      join(scratch, "src/generated/agent-model-call-bound-v1"),
      { recursive: true },
    );
    await cp(join(root, ".prettierrc.json"), join(scratch, ".prettierrc.json"));
    await symlink(
      join(root, "node_modules"),
      join(scratch, "node_modules"),
      "dir",
    );
    await generateAgentUsageArtifacts(scratch, true);
    for (const name of [
      "index.ts",
      "types.gen.ts",
      "schema.gen.ts",
      "bound-http.gen.ts",
      "bound-http-schema.gen.ts",
      "capacity-guarantee.gen.ts",
    ]) {
      const path = join(
          scratch,
          "src/generated/agent-model-call-bound-v1",
          name,
        ),
        original = await readFile(path);
      const changed = Buffer.concat([original, Buffer.from("\n// drift\n")]);
      await writeFile(path, changed);
      await expect(generateAgentUsageArtifacts(scratch, true)).rejects.toThrow(
        "Agent bound generated artifact drift",
      );
      expect(await readFile(path)).toEqual(changed);
      await writeFile(path, original);
    }
  } finally {
    await rename(scratch, join(homedir(), ".Trash", basename(scratch)));
  }
});

it("accepts exactly 128 safe request ID characters and snapshots that ID", async () => {
  const w = wire(),
    requestId = "A".repeat(128);
  w.body.meta.request_id = requestId;
  await withServer(
    (_req, res) =>
      res
        .writeHead(200, { ...headers, "x-request-id": requestId })
        .end(JSON.stringify(w.body)),
    async (reader) => {
      const input = {
        expected: w.expected,
        requestId,
        signal: new AbortController().signal,
      };
      const pending = reader.readBound(input);
      input.requestId = "changed";
      expect((await pending).originalBoundJson).toBe(w.boundText);
    },
  );
});

it("decodes split UTF8 error-body chunks only after the complete response", async () => {
  const body = Buffer.from(
    JSON.stringify({
      error: { code: "model_call_bound_expired", message: "到期😀" },
      meta: { request_id: "bound-test" },
    }),
  );
  const split = body.indexOf(Buffer.from("到")) + 1;
  await withServer(
    (_req, res) => {
      res.writeHead(410, headers);
      res.write(body.subarray(0, split));
      const timer = setTimeout(() => res.end(body.subarray(split)), 10);
      res.once("close", () => clearTimeout(timer));
    },
    async (reader) => {
      await expect(read(reader)).rejects.toMatchObject({ code: "EXPIRED" });
    },
  );
});

it.each([400, 500, 418])(
  "rejects unsupported status %s even with an owner-shaped body",
  async (status) => {
    await withServer(
      (_req, res) =>
        res.writeHead(status, headers).end(
          JSON.stringify({
            error: {
              code: "invalid_model_call_bound_identity",
              message: "invalid",
            },
            meta: { request_id: "bound-test" },
          }),
        ),
      async (reader) => {
        await expect(read(reader)).rejects.toMatchObject({
          code: "CONTRACT_INVALID",
        });
      },
    );
  },
);
