import type { MeteringPricingRevisionRepository } from "./metering-pricing-revision.repository.js";
import type {
  MeteringPricingSelectionBinding,
  MeteringPricingSelectionInput,
  MeteringPricingSelectionRequest,
  MeteringPricingSelectionResult,
} from "./metering-pricing-selection.types.js";
import { MeteringError } from "./metering.error.js";

const INT64_MAX = 9_223_372_036_854_775_807n;

function invalid(): never {
  throw new MeteringError(
    "METERING_SELECTION_INVALID",
    "Metering rate selection is invalid",
  );
}

function object(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0) invalid();
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

function businessKey(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(result)) invalid();
  return result;
}

function binding(value: unknown): MeteringPricingSelectionBinding {
  const fields = object(value, [
    "providerRef",
    "environment",
    "pricingAccountRef",
    "modelRef",
    "modelVersion",
  ]);
  return Object.freeze({
    providerRef: text(fields.providerRef, 255),
    environment: text(fields.environment, 255),
    pricingAccountRef: text(fields.pricingAccountRef, 255),
    modelRef: text(fields.modelRef, 255),
    modelVersion: text(fields.modelVersion, 255),
  });
}

function request(value: unknown): MeteringPricingSelectionRequest {
  const fields = object(value, ["bucket", "unit", "applicability"]);
  if (fields.applicability === null || typeof fields.applicability !== "object")
    invalid();
  const kindDescriptor = Object.getOwnPropertyDescriptor(
    fields.applicability,
    "kind",
  );
  const kind: unknown = kindDescriptor?.value;
  if (kind === "all") {
    object(fields.applicability, ["kind"]);
    return Object.freeze({
      bucket: businessKey(fields.bucket),
      unit: businessKey(fields.unit),
      applicability: Object.freeze({ kind: "all" as const }),
    });
  }
  if (kind !== "range") invalid();
  const range = object(fields.applicability, [
    "kind",
    "dimension",
    "unit",
    "value",
  ]);
  const parsed = text(range.value, 19);
  if (!/^(?:0|[1-9][0-9]{0,18})$/u.test(parsed)) invalid();
  const amount = BigInt(parsed);
  if (amount > INT64_MAX) invalid();
  return Object.freeze({
    bucket: businessKey(fields.bucket),
    unit: businessKey(fields.unit),
    applicability: Object.freeze({
      kind: "range" as const,
      dimension: businessKey(range.dimension),
      unit: businessKey(range.unit),
      value: amount.toString(),
    }),
  });
}

function parse(input: unknown): MeteringPricingSelectionInput {
  const fields = object(input, [
    "tenantId",
    "profileRef",
    "binding",
    "requests",
  ]);
  const profile = object(fields.profileRef, ["version", "artifactDigest"]);
  if (
    !Array.isArray(fields.requests) ||
    Object.getPrototypeOf(fields.requests) !== Array.prototype ||
    fields.requests.length < 1 ||
    fields.requests.length > 64 ||
    Reflect.ownKeys(fields.requests).length !== fields.requests.length + 1
  )
    invalid();
  const requests = Array.from(
    { length: fields.requests.length },
    (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        fields.requests,
        String(index),
      );
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        invalid();
      return request(descriptor.value);
    },
  );
  const identities = requests.map((item) => JSON.stringify(item));
  if (new Set(identities).size !== identities.length) invalid();
  const artifactDigest = text(profile.artifactDigest, 64);
  if (!/^[0-9a-f]{64}$/u.test(artifactDigest)) invalid();
  return Object.freeze({
    tenantId: text(fields.tenantId, 191),
    profileRef: Object.freeze({
      version: text(profile.version, 255),
      artifactDigest,
    }),
    binding: binding(fields.binding),
    requests: Object.freeze(requests),
  });
}

export class MeteringPricingSelectionService {
  constructor(private readonly repository: MeteringPricingRevisionRepository) {}

  selectActivePricing(
    input: MeteringPricingSelectionInput,
  ): Promise<MeteringPricingSelectionResult> {
    return this.repository.selectActivePricing(parse(input));
  }
}
