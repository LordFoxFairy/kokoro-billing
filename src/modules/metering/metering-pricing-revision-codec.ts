import { commandDigest } from "../../database/canonical-digest.js";
import type {
  MeteringPolicyRevisionDraft,
  MeteringPublicationEncoding,
  MeteringRateApplicability,
  MeteringRateRevisionDraft,
  MeteringRevisionEncoding,
  MeteringRevisionRate,
  MeteringRevisionRational,
  MeteringRevisionReference,
} from "./metering-pricing-revision.types.js";

const MAX_CANONICAL_BYTES = 262_144;
const INT64_MAX = 9_223_372_036_854_775_807n;
const COMMON_FIELDS = [
  "schemaVersion",
  "tenantId",
  "effectiveFrom",
  "sourceRef",
  "verifiedAt",
  "profileRef",
] as const;

function invalid(): never {
  // Never echo untrusted drafts, procurement information or credentials.
  throw new TypeError("Invalid metering revision draft or canonical encoding");
}

/** Read descriptors rather than invoking getters or inherited/toJSON behavior. */
function object(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Reflect.ownKeys(value).length !== keys.length) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      invalid();
    const item: unknown = descriptor.value;
    if (item === undefined) invalid();
    result[key] = item;
  }
  return result;
}

function array(value: unknown, min: number, max = min): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid();
  if (
    value.length < min ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      invalid();
    const item: unknown = descriptor.value;
    if (item === undefined) invalid();
    result.push(item);
  }
  return result;
}

function text(value: unknown, maximum = 255): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum * 2
  )
    invalid();
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point === undefined ||
      point === 0 ||
      (point >= 0xd800 && point <= 0xdfff) ||
      ++count > maximum
    )
      invalid();
  }
  return value;
}

function matching(value: unknown, pattern: RegExp, maximum: number): string {
  const parsed = text(value, maximum);
  // Full match also rejects a trailing newline, which JavaScript's $ alone allows.
  if (pattern.exec(parsed)?.[0] !== parsed) invalid();
  return parsed;
}

function literal<T extends string>(value: unknown, expected: T): T {
  if (value !== expected) invalid();
  return expected;
}

function businessKey(value: unknown): string {
  return matching(value, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, 128);
}

function currency(value: unknown): string {
  return matching(value, /^[A-Z]{3}$/u, 3);
}

function reference(value: unknown): MeteringRevisionReference {
  const fields = object(value, ["version", "artifactDigest"]);
  return {
    version: text(fields.version),
    artifactDigest: matching(fields.artifactDigest, /^[0-9a-f]{64}$/u, 64),
  };
}

function instant(value: unknown): string {
  const parsed = matching(
    value,
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9]\.[0-9]{3}Z$/u,
    24,
  );
  if (parsed.startsWith("0000-")) invalid();
  // Explicit input only; no current-clock reads. Round-trip rejects invalid days,
  // 24:00 and every spelling that Date would silently normalize.
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed)
    invalid();
  return parsed;
}

function decimal(value: unknown): string {
  return matching(value, /^(?:0|[1-9][0-9]{0,77})$/u, 78);
}

function bound(value: unknown): string {
  const parsed = decimal(value);
  if (BigInt(parsed) > INT64_MAX) invalid();
  return parsed;
}

function rational(value: unknown, positive: boolean): MeteringRevisionRational {
  const fields = object(value, ["numerator", "denominator"]);
  const numerator = decimal(fields.numerator);
  const denominator = decimal(fields.denominator);
  let a = BigInt(numerator);
  let b = BigInt(denominator);
  if (b === 0n || (positive && a === 0n)) invalid();
  while (b !== 0n) [a, b] = [b, a % b];
  if (a !== 1n) invalid();
  return { numerator, denominator };
}

function applicability(value: unknown): MeteringRateApplicability {
  // Check the discriminator without reading any unvalidated properties.
  if (value === null || typeof value !== "object") invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  const kind: unknown =
    descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  if (kind === "all") {
    object(value, ["kind"]);
    return { kind: "all" };
  }
  if (kind !== "range") invalid();
  const fields = object(value, [
    "kind",
    "dimension",
    "unit",
    "lowerInclusive",
    "upperExclusive",
  ]);
  const lowerInclusive = bound(fields.lowerInclusive);
  const upperExclusive =
    fields.upperExclusive === null ? null : bound(fields.upperExclusive);
  if (
    upperExclusive !== null &&
    BigInt(upperExclusive) <= BigInt(lowerInclusive)
  )
    invalid();
  return {
    kind: "range",
    dimension: businessKey(fields.dimension),
    unit: businessKey(fields.unit),
    lowerInclusive,
    upperExclusive,
  };
}

function rate(value: unknown): MeteringRevisionRate {
  const fields = object(value, [
    "providerRef",
    "environment",
    "pricingAccountRef",
    "modelRef",
    "modelVersion",
    "bucket",
    "unit",
    "applicability",
    "currencyCode",
    "minorPerUnit",
  ]);
  return {
    providerRef: text(fields.providerRef),
    environment: text(fields.environment),
    pricingAccountRef: text(fields.pricingAccountRef),
    modelRef: text(fields.modelRef),
    modelVersion: text(fields.modelVersion),
    bucket: businessKey(fields.bucket),
    unit: businessKey(fields.unit),
    applicability: applicability(fields.applicability),
    currencyCode: currency(fields.currencyCode),
    minorPerUnit: rational(fields.minorPerUnit, false),
  };
}

function applicabilityTuple(value: MeteringRateApplicability) {
  return value.kind === "all"
    ? (["all"] as const)
    : ([
        "range",
        value.dimension,
        value.unit,
        value.lowerInclusive,
        value.upperExclusive,
      ] as const);
}
function referenceTuple(value: MeteringRevisionReference) {
  return [value.version, value.artifactDigest] as const;
}
function rationalTuple(value: MeteringRevisionRational) {
  return [value.numerator, value.denominator] as const;
}
function bindingTuple(value: MeteringRevisionRate) {
  return [
    value.providerRef,
    value.environment,
    value.pricingAccountRef,
    value.modelRef,
    value.modelVersion,
  ] as const;
}
function rateKeyTuple(value: MeteringRevisionRate) {
  return [
    ...bindingTuple(value),
    value.bucket,
    value.unit,
    applicabilityTuple(value.applicability),
  ] as const;
}
function rateTuple(value: MeteringRevisionRate) {
  return [
    ...rateKeyTuple(value),
    value.currencyCode,
    rationalTuple(value.minorPerUnit),
  ] as const;
}

function validateIntervals(
  a: MeteringRateApplicability,
  b: MeteringRateApplicability,
): void {
  if (
    a.kind === "all" ||
    b.kind === "all" ||
    a.dimension !== b.dimension ||
    a.unit !== b.unit
  )
    invalid();
  if (
    (a.upperExclusive === null ||
      BigInt(b.lowerInclusive) < BigInt(a.upperExclusive)) &&
    (b.upperExclusive === null ||
      BigInt(a.lowerInclusive) < BigInt(b.upperExclusive))
  )
    invalid();
}

function rateSet(value: unknown): readonly MeteringRevisionRate[] {
  const rows = array(value, 1, 64).map(rate);
  const keys = new Set<string>();
  const currencies = new Map<string, string>();
  const intervals = new Map<string, MeteringRateApplicability[]>();
  const entries = rows.map((row) => {
    const key = JSON.stringify(rateKeyTuple(row));
    if (keys.has(key)) invalid();
    keys.add(key);
    const binding = JSON.stringify(bindingTuple(row));
    const previousCurrency = currencies.get(binding);
    if (previousCurrency !== undefined && previousCurrency !== row.currencyCode)
      invalid();
    currencies.set(binding, row.currencyCode);
    const group = JSON.stringify([...bindingTuple(row), row.bucket, row.unit]);
    const prior = intervals.get(group) ?? [];
    for (const interval of prior)
      validateIntervals(interval, row.applicability);
    prior.push(row.applicability);
    intervals.set(group, prior);
    return { row, key: Buffer.from(key, "utf8") };
  });
  entries.sort((a, b) => Buffer.compare(a.key, b.key));
  return entries.map((entry) => entry.row);
}

function common(fields: Readonly<Record<string, unknown>>) {
  return {
    schemaVersion: literal(fields.schemaVersion, "1"),
    tenantId: text(fields.tenantId, 191),
    effectiveFrom: instant(fields.effectiveFrom),
    sourceRef: text(fields.sourceRef),
    verifiedAt: instant(fields.verifiedAt),
    profileRef: reference(fields.profileRef),
  };
}
function rateDraft(value: unknown): MeteringRateRevisionDraft {
  const fields = object(value, [...COMMON_FIELDS, "rates"]);
  return { ...common(fields), rates: rateSet(fields.rates) };
}
function policyDraft(value: unknown): MeteringPolicyRevisionDraft {
  const fields = object(value, [
    ...COMMON_FIELDS,
    "currencyCode",
    "multiplier",
    "creditMicrosPerMinor",
    "roundingVersion",
    "failurePolicyRef",
  ]);
  return {
    ...common(fields),
    currencyCode: currency(fields.currencyCode),
    multiplier: rational(fields.multiplier, true),
    creditMicrosPerMinor: rational(fields.creditMicrosPerMinor, true),
    roundingVersion: literal(fields.roundingVersion, "attempt-ceil-v1"),
    failurePolicyRef:
      fields.failurePolicyRef === null
        ? null
        : reference(fields.failurePolicyRef),
  };
}
function commonTuple(
  draft: MeteringRateRevisionDraft | MeteringPolicyRevisionDraft,
) {
  return [
    draft.schemaVersion,
    draft.tenantId,
    draft.effectiveFrom,
    draft.sourceRef,
    draft.verifiedAt,
    referenceTuple(draft.profileRef),
  ] as const;
}

/** Only private, constructed tuples reach the existing permissive digest helper. */
function encodeTuple(tuple: readonly unknown[]): MeteringRevisionEncoding {
  const canonicalJson = JSON.stringify({ value: tuple });
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_CANONICAL_BYTES) invalid();
  return { canonicalJson, contentDigest: commandDigest({ value: tuple }) };
}
function encodeRate(
  draft: MeteringRateRevisionDraft,
): MeteringRevisionEncoding {
  return encodeTuple([
    "kokoro.billing.metering.rate.content",
    ...commonTuple(draft),
    draft.rates.map(rateTuple),
  ]);
}
function encodePolicy(
  draft: MeteringPolicyRevisionDraft,
): MeteringRevisionEncoding {
  return encodeTuple([
    "kokoro.billing.metering.policy.content",
    ...commonTuple(draft),
    draft.currencyCode,
    rationalTuple(draft.multiplier),
    rationalTuple(draft.creditMicrosPerMinor),
    draft.roundingVersion,
    draft.failurePolicyRef === null
      ? null
      : referenceTuple(draft.failurePolicyRef),
  ]);
}

/** Pure draft encoding: does not prove artifact publication, authorization or tariff completeness. */
export function encodeMeteringRateRevisionDraft(
  value: unknown,
): MeteringRevisionEncoding {
  return encodeRate(rateDraft(value));
}
/** Pending failurePolicyRef stays null; even a named reference carries no executable authority. */
export function encodeMeteringPolicyRevisionDraft(
  value: unknown,
): MeteringRevisionEncoding {
  return encodePolicy(policyDraft(value));
}

function canonicalTuple(
  value: unknown,
  domain: string,
  length: number,
): readonly unknown[] {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_CANONICAL_BYTES
  )
    invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid();
  }
  const tuple = array(object(parsed, ["value"]).value, length);
  literal(tuple[0], domain);
  return tuple;
}
function unpackReference(value: unknown) {
  const tuple = array(value, 2);
  return { version: tuple[0], artifactDigest: tuple[1] };
}
function unpackRational(value: unknown) {
  const tuple = array(value, 2);
  return { numerator: tuple[0], denominator: tuple[1] };
}
function unpackApplicability(value: unknown) {
  const tuple = array(value, 1, 5);
  if (tuple[0] === "all" && tuple.length === 1) return { kind: "all" };
  if (tuple[0] !== "range" || tuple.length !== 5) invalid();
  return {
    kind: "range",
    dimension: tuple[1],
    unit: tuple[2],
    lowerInclusive: tuple[3],
    upperExclusive: tuple[4],
  };
}
function unpackRate(value: unknown) {
  const tuple = array(value, 10);
  return {
    providerRef: tuple[0],
    environment: tuple[1],
    pricingAccountRef: tuple[2],
    modelRef: tuple[3],
    modelVersion: tuple[4],
    bucket: tuple[5],
    unit: tuple[6],
    applicability: unpackApplicability(tuple[7]),
    currencyCode: tuple[8],
    minorPerUnit: unpackRational(tuple[9]),
  };
}
function unpackCommon(tuple: readonly unknown[]) {
  return {
    schemaVersion: tuple[1],
    tenantId: tuple[2],
    effectiveFrom: tuple[3],
    sourceRef: tuple[4],
    verifiedAt: tuple[5],
    profileRef: unpackReference(tuple[6]),
  };
}

export function decodeMeteringRateRevisionDraft(
  value: unknown,
): MeteringRateRevisionDraft {
  const tuple = canonicalTuple(
    value,
    "kokoro.billing.metering.rate.content",
    8,
  );
  const draft = rateDraft({
    ...unpackCommon(tuple),
    rates: array(tuple[7], 1, 64).map(unpackRate),
  });
  if (encodeRate(draft).canonicalJson !== value) invalid();
  return draft;
}
export function decodeMeteringPolicyRevisionDraft(
  value: unknown,
): MeteringPolicyRevisionDraft {
  const tuple = canonicalTuple(
    value,
    "kokoro.billing.metering.policy.content",
    12,
  );
  const draft = policyDraft({
    ...unpackCommon(tuple),
    currencyCode: tuple[7],
    multiplier: unpackRational(tuple[8]),
    creditMicrosPerMinor: unpackRational(tuple[9]),
    roundingVersion: tuple[10],
    failurePolicyRef: tuple[11] === null ? null : unpackReference(tuple[11]),
  });
  if (encodePolicy(draft).canonicalJson !== value) invalid();
  return draft;
}

function publication(
  value: unknown,
  kind: "rate" | "policy",
): MeteringPublicationEncoding {
  const fields = object(value, [
    "tenantId",
    "actorId",
    "publicationIdentity",
    "idempotencyKey",
    "reason",
    "draft",
  ]);
  const tenantId = text(fields.tenantId, 191);
  const actorId = text(fields.actorId);
  const commandIdentity = text(fields.publicationIdentity);
  const idempotencyKey = text(fields.idempotencyKey, 128);
  const reason = text(fields.reason, 500);
  const draft =
    kind === "rate" ? rateDraft(fields.draft) : policyDraft(fields.draft);
  if (draft.tenantId !== tenantId) invalid();
  const content = "rates" in draft ? encodeRate(draft) : encodePolicy(draft);
  const command = encodeTuple([
    `kokoro.billing.metering.${kind}.command`,
    "1",
    tenantId,
    commandIdentity,
    actorId,
    reason,
    content.contentDigest,
  ]);
  return {
    tenantId,
    namespace: "general",
    apiSurface: "internal",
    commandName: `metering.publish_${kind}_revision`,
    commandIdentity,
    idempotencyKey,
    requestSchemaVersion: 1,
    canonicalJson: command.canonicalJson,
    contentDigest: content.contentDigest,
    payloadDigest: command.contentDigest,
  };
}

/** Constructs strict receipt inputs; the later publisher owns durable identity/key enforcement. */
export function encodeMeteringRatePublicationCommand(
  value: unknown,
): MeteringPublicationEncoding {
  return publication(value, "rate");
}
export function encodeMeteringPolicyPublicationCommand(
  value: unknown,
): MeteringPublicationEncoding {
  return publication(value, "policy");
}
