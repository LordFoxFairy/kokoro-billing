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
