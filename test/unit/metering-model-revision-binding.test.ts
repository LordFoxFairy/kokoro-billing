import { expect, it } from "vitest";
import {
  decodeMeteringRateRevisionDraft,
  encodeMeteringRatePublicationCommand,
  encodeMeteringRateRevisionDraft,
} from "../../src/modules/metering/metering-pricing-revision-codec.js";
import { MeteringPricingSelectionService } from "../../src/modules/metering/metering-pricing-selection.service.js";
import type { MeteringPricingRevisionRepository } from "../../src/modules/metering/metering-pricing-revision.repository.js";

const modelRevision = {
  id: "11111111-1111-4111-8111-111111111111",
  contentDigest: "a".repeat(64),
};
const row = {
  modelRevision,
  providerRef: "verified-provider",
  environment: "verified-environment",
  pricingAccountRef: "verified-commercial-account",
  modelRef: "verified-commercial-model",
  modelVersion: "verified-price-version",
  bucket: "input_total",
  unit: "token",
  applicability: { kind: "all" },
  currencyCode: "XTS",
  minorPerUnit: { numerator: "1", denominator: "10" },
};
const draft = {
  schemaVersion: "2",
  tenantId: "tenant-test",
  effectiveFrom: "2026-10-22T00:00:00.000Z",
  sourceRef: "synthetic explicit mapping",
  verifiedAt: "2026-10-22T00:00:00.000Z",
  profileRef: { version: "test-profile", artifactDigest: "0".repeat(64) },
  rates: [row],
};
it("publishes and canonically binds the exact System revision pair in rate schema2", () => {
  const encoded = encodeMeteringRateRevisionDraft(draft);
  expect(decodeMeteringRateRevisionDraft(encoded.canonicalJson)).toEqual(draft);
  expect(
    encodeMeteringRatePublicationCommand({
      tenantId: draft.tenantId,
      actorId: "admin",
      publicationIdentity: "one",
      idempotencyKey: "original-key",
      reason: "verified mapping",
      draft,
    }).requestSchemaVersion,
  ).toBe(2);
  for (const changed of [
    { ...modelRevision, id: "22222222-2222-4222-8222-222222222222" },
    { ...modelRevision, contentDigest: "b".repeat(64) },
  ])
    expect(
      encodeMeteringRateRevisionDraft({
        ...draft,
        rates: [{ ...row, modelRevision: changed }],
      }).contentDigest,
    ).not.toBe(encoded.contentDigest);
});
it("allows independent exact revisions to reuse commercial rates without aliasing identities", () => {
  const other = {
    ...row,
    modelRevision: {
      ...modelRevision,
      id: "22222222-2222-4222-8222-222222222222",
    },
  };
  expect(
    decodeMeteringRateRevisionDraft(
      encodeMeteringRateRevisionDraft({ ...draft, rates: [row, other] })
        .canonicalJson,
    ).rates,
  ).toHaveLength(2);
});
it("rejects missing, malformed, extra or pre-binding revision identities instead of guessing", () => {
  const { modelRevision: omitted, ...without } = row;
  expect(omitted).toEqual(modelRevision);
  for (const value of [
    { ...draft, schemaVersion: "1" },
    { ...draft, rates: [without] },
    ...[
      null,
      {},
      { ...modelRevision, extra: true },
      { ...modelRevision, id: "provider/model" },
      { ...modelRevision, contentDigest: "A".repeat(64) },
    ].map((binding) => ({
      ...draft,
      rates: [{ ...row, modelRevision: binding }],
    })),
  ])
    expect(() => encodeMeteringRateRevisionDraft(value)).toThrow();
});
it("rejects divergent commercial accounts, models or currencies for one exact technical revision", () => {
  for (const changed of [
    { pricingAccountRef: "other" },
    { modelVersion: "other" },
    { providerRef: "other" },
    { environment: "other" },
    { modelRef: "other" },
    { currencyCode: "USD" },
  ])
    expect(() =>
      encodeMeteringRateRevisionDraft({
        ...draft,
        rates: [row, { ...row, bucket: "output_total", ...changed }],
      }),
    ).toThrow();
});
it("selects using a frozen technical pair, never a caller-authored commercial tuple", async () => {
  let received: unknown;
  const repository = {
    selectActivePricing: (input: unknown) => {
      received = input;
      return Promise.resolve(Object.freeze({ selected: true }));
    },
  };
  const service = new MeteringPricingSelectionService(
    repository as unknown as MeteringPricingRevisionRepository,
  );
  const input = {
    tenantId: "tenant-test",
    profileRef: draft.profileRef,
    modelRevision: { ...modelRevision },
    requests: [
      { bucket: "input_total", unit: "token", applicability: { kind: "all" } },
    ],
  };
  await expect(service.selectActivePricing(input as never)).resolves.toEqual({
    selected: true,
  });
  expect(received).toEqual(input);
  expect(Object.isFrozen(received)).toBe(true);
  expect(
    Object.isFrozen((received as { modelRevision: unknown }).modelRevision),
  ).toBe(true);
  input.modelRevision.contentDigest = "b".repeat(64);
  expect(
    (received as { modelRevision: typeof modelRevision }).modelRevision
      .contentDigest,
  ).toBe("a".repeat(64));
  received = undefined;
  expect(() =>
    service.selectActivePricing({
      ...input,
      binding: { providerRef: "self" },
    } as never),
  ).toThrow();
  expect(received).toBeUndefined();
});
