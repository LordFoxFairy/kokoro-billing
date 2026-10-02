import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { CreditError } from "../../src/modules/credit/credit.error.js";
import {
  decodeCreditLedgerCursor,
  encodeCreditLedgerCursor,
} from "../../src/modules/credit/credit-ledger-cursor.js";

function fixtureIdentityDigest(identity: {
  tenantId: string;
  subjectId: string;
}) {
  // Independent wire fixture: domain tag + uint32-BE UTF-8 byte lengths.
  const hash = createHash("sha256");
  hash.update("kokoro.billing.credit-ledger.identity.v1\0", "utf8");
  for (const value of [identity.tenantId, identity.subjectId]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("base64url");
}

const context = { tenantId: "tenant-a", subjectId: "subject-a" };
const payload = {
  version: 1,
  scope: "credit.ledger",
  identityDigest: fixtureIdentityDigest(context),
  accountId: "a7fe4a6b-c77f-45e2-871c-4e0f8500caf0",
  highWaterSequence: "9007199254740993",
  lastSequence: "9007199254740992",
};
const raw = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const invalid = (value: unknown, identity = context) => {
  let failure: unknown;
  try {
    decodeCreditLedgerCursor(value, identity);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CreditError);
  expect(failure).toMatchObject({ code: "CREDIT_INVALID_CURSOR" });
};

describe("Credit ledger bounded cursor", () => {
  test("round-trips exact bigint boundaries and preserves Unicode identity", () => {
    const unicode = { tenantId: "租户", subjectId: "subject-😀" };
    const value = {
      version: 1 as const,
      scope: "credit.ledger" as const,
      ...unicode,
      accountId: payload.accountId,
      highWaterSequence: 9007199254740993n,
      lastSequence: 9007199254740992n,
    };
    const encoded = encodeCreditLedgerCursor(value);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded.length).toBeLessThanOrEqual(2048);
    expect(decodeCreditLedgerCursor(encoded, unicode)).toEqual(value);
    const decoded: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString(),
    );
    expect(decoded).toMatchObject({
      highWaterSequence: "9007199254740993",
      lastSequence: "9007199254740992",
    });
  });

  test("accepts zero and the PostgreSQL bigint ceiling without Number conversion", () => {
    expect(
      decodeCreditLedgerCursor(
        raw({
          ...payload,
          highWaterSequence: "9223372036854775807",
          lastSequence: "0",
        }),
        context,
      ),
    ).toMatchObject({
      highWaterSequence: 9223372036854775807n,
      lastSequence: 0n,
    });
  });

  test.each([
    undefined,
    null,
    1,
    false,
    {},
    [],
    "",
    "x".repeat(2049),
    "invalid%",
    raw(payload) + "=",
    raw(payload) + "\n",
    Buffer.from([0xff]).toString("base64url"),
    Buffer.from("{").toString("base64url"),
    raw(null),
    raw([]),
    raw({}),
    Buffer.from("\ufeff" + JSON.stringify(payload)).toString("base64url"),
  ])("rejects malformed encoding/value #%#", (value) => {
    expect(() => decodeCreditLedgerCursor(raw(payload), context)).not.toThrow();
    invalid(value);
  });

  test.each([
    { version: 2 },
    { version: "1" },
    { scope: "other" },
    { extra: true },
    { accountId: "not-uuid" },
    { accountId: undefined },
    { tenantId: "other-tenant" },
    { subjectId: "other-subject" },
    { tenantId: "" },
    { subjectId: "" },
    { tenantId: "x".repeat(192) },
    { subjectId: "x".repeat(256) },
    { tenantId: "a\0b" },
    { subjectId: "\ud800" },
    ...["highWaterSequence", "lastSequence"].flatMap((key) =>
      [
        undefined,
        null,
        1,
        -1,
        "",
        "01",
        "-1",
        "+1",
        "1.5",
        "1e3",
        " 1",
        "9223372036854775808",
      ].map((value) => ({ [key]: value })),
    ),
    { highWaterSequence: "1", lastSequence: "2" },
  ])("rejects closed payload violation #%#", (patch) => {
    expect(() => decodeCreditLedgerCursor(raw(payload), context)).not.toThrow();
    const fields: Record<string, unknown> = patch;
    const { tenantId, subjectId, ...wirePatch } = fields;
    const identity = {
      tenantId: typeof tenantId === "string" ? tenantId : context.tenantId,
      subjectId: typeof subjectId === "string" ? subjectId : context.subjectId,
    };
    // Foreign valid identities test binding; invalid identities test the trusted
    // context domain itself, rather than failing on removed raw wire keys.
    const trusted =
      tenantId === "other-tenant" || subjectId === "other-subject"
        ? context
        : identity;
    invalid(
      raw({
        ...payload,
        identityDigest: fixtureIdentityDigest(identity),
        ...wirePatch,
      }),
      trusted,
    );
  });

  test("rejects noncanonical base64url trailing bits", () => {
    // These bytes decode identically, but only one spelling is canonical.
    const json = JSON.stringify(payload);
    const encoded = Buffer.from(
      json + (Buffer.byteLength(json, "utf8") % 3 === 0 ? " " : ""),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCreditLedgerCursor(encoded, context)).not.toThrow();
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const canonicalIndex = alphabet.indexOf(encoded.at(-1) ?? "");
    expect(encoded.length % 4).not.toBe(0);
    const alias = encoded.slice(0, -1) + alphabet[canonicalIndex + 1];
    expect(Buffer.from(alias, "base64url")).toEqual(
      Buffer.from(encoded, "base64url"),
    );
    invalid(alias);
  });
});

describe("R51 Credit cursor identity capacity and binding", () => {
  const internal = (identity = context) => ({
    version: 1 as const,
    scope: "credit.ledger" as const,
    ...identity,
    accountId: payload.accountId,
    highWaterSequence: 9007199254740993n,
    lastSequence: 9007199254740992n,
  });
  const wire = (encoded: string) => {
    const decoded: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    expect(decoded).toMatchObject({
      version: 1,
      scope: "credit.ledger",
      accountId: payload.accountId,
      highWaterSequence: "9007199254740993",
      lastSequence: "9007199254740992",
    });
    const fields = decoded as Record<string, unknown>;
    expect(typeof fields.identityDigest).toBe("string");
    expect(fields.identityDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Object.keys(decoded as object).sort()).toEqual([
      "accountId",
      "highWaterSequence",
      "identityDigest",
      "lastSequence",
      "scope",
      "version",
    ]);
    return fields;
  };
  const reject = (value: unknown, identity = context) => {
    let failure: unknown;
    try {
      decodeCreditLedgerCursor(value, identity);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CreditError);
    expect(failure).toMatchObject({ code: "CREDIT_INVALID_CURSOR" });
  };

  test("accepts tenant191 and subject255 four-byte identities within raw2048", () => {
    const identity = {
      tenantId: "😀".repeat(191),
      subjectId: "🦊".repeat(255),
    };
    expect(Array.from(identity.tenantId)).toHaveLength(191);
    expect(Array.from(identity.subjectId)).toHaveLength(255);
    const value = internal(identity);
    const encoded = encodeCreditLedgerCursor(value);
    expect(encoded.length).toBeLessThanOrEqual(2048);
    wire(encoded);
    expect(decodeCreditLedgerCursor(encoded, identity)).toEqual(value);
  });

  test("accepts subject255 ASCII independently of multibyte cursor capacity", () => {
    const identity = { ...context, subjectId: "s".repeat(255) };
    const value = internal(identity);
    const encoded = encodeCreditLedgerCursor(value);
    wire(encoded);
    expect(decodeCreditLedgerCursor(encoded, identity)).toEqual(value);
  });

  test("disambiguates concatenated tenant/subject identities and rejects cross-context replay", () => {
    const first = { tenantId: "a", subjectId: "bc" };
    const second = { tenantId: "ab", subjectId: "c" };
    expect(first.tenantId + first.subjectId).toBe(
      second.tenantId + second.subjectId,
    );
    const a = encodeCreditLedgerCursor(internal(first));
    const b = encodeCreditLedgerCursor(internal(second));
    const aWire = wire(a);
    const bWire = wire(b);
    expect(aWire.identityDigest).not.toBe(bWire.identityDigest);
    expect(decodeCreditLedgerCursor(a, first)).toEqual(internal(first));
    expect(decodeCreditLedgerCursor(b, second)).toEqual(internal(second));
    reject(a, second);
    reject(b, first);
  });

  test("binds either identity component before accepting the cursor", () => {
    const encoded = encodeCreditLedgerCursor(internal());
    wire(encoded);
    expect(decodeCreditLedgerCursor(encoded, context)).toEqual(internal());
    reject(encoded, { ...context, tenantId: "other-tenant" });
    reject(encoded, { ...context, subjectId: "other-subject" });
  });

  test("rejects cross-scope tokens despite a matching identity digest", () => {
    const encoded = encodeCreditLedgerCursor(internal());
    const value = wire(encoded);
    expect(decodeCreditLedgerCursor(encoded, context)).toEqual(internal());
    reject(raw({ ...value, scope: "other" }));
    reject(raw({ ...value, version: 2 }));
  });

  test.each([
    undefined,
    null,
    1,
    false,
    "",
    "A".repeat(42),
    "A".repeat(44),
    "%".repeat(43),
    "A".repeat(43),
  ])(
    "rejects absent/malformed/forged identity digest #%#",
    (identityDigest) => {
      const value = wire(encodeCreditLedgerCursor(internal()));
      reject(raw({ ...value, identityDigest }));
    },
  );

  test("rejects the former raw-identity format rather than accepting two wire formats", () => {
    expect(() => decodeCreditLedgerCursor(raw(payload), context)).not.toThrow();
    reject(
      raw({
        version: payload.version,
        scope: payload.scope,
        ...context,
        accountId: payload.accountId,
        highWaterSequence: payload.highWaterSequence,
        lastSequence: payload.lastSequence,
      }),
    );
  });
});
