import { createHash, randomUUID } from "node:crypto";
import type { TransactionService } from "../../database/transaction.service.js";
import { assertExecutableMeteringPolicy } from "./metering-policy-artifact.js";
import {
  encodeMeteringPolicyRevisionDraft,
  decodeMeteringPolicyRevisionDraft,
  encodeMeteringRateRevisionDraft,
} from "./metering-pricing-revision-codec.js";
import type {
  MeteringPolicyRevisionDraft,
  MeteringRateApplicability,
  MeteringRateRevisionDraft,
  MeteringRevisionRate,
} from "./metering-pricing-revision.types.js";
import type { MeteringPricingPublicationResultV1 } from "./metering-pricing-publication-result-codec.js";
import type {
  MeteringPricingSelectionInput,
  MeteringPricingSelectionResult,
} from "./metering-pricing-selection.types.js";
import { MeteringError } from "./metering.error.js";

const MAX_REVISION = 9_223_372_036_854_775_807n;
const keyTuple = (rate: MeteringRevisionRate) => [
  "kokoro.billing.metering.rate.key.v1",
  rate.providerRef,
  rate.environment,
  rate.pricingAccountRef,
  rate.modelRef,
  rate.modelVersion,
  rate.bucket,
  rate.unit,
  rate.applicability.kind === "all"
    ? ["all"]
    : [
        "range",
        rate.applicability.dimension,
        rate.applicability.unit,
        rate.applicability.lowerInclusive,
        rate.applicability.upperExclusive,
      ],
];
const keyDigest = (rate: MeteringRevisionRate) =>
  createHash("sha256")
    .update(JSON.stringify(keyTuple(rate)), "utf8")
    .digest("hex");

export type MeteringPricingPublicationEffect<Kind extends "rate" | "policy"> =
  Readonly<{
    revisionId: string;
    result: MeteringPricingPublicationResultV1<Kind>;
  }>;

export class MeteringPricingRevisionRepository {
  constructor(private readonly transactions: TransactionService) {}

  async publishRate(
    draft: MeteringRateRevisionDraft,
    contentDigest: string,
  ): Promise<MeteringPricingPublicationEffect<"rate">> {
    const client = this.transactions.requireActiveTransaction(
      draft.tenantId,
      "write",
    );
    const lock = `metering:pricing-generation:rate:${draft.tenantId}`;
    await client.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    const maxima = await client.$queryRaw<
      readonly { revision: string | null }[]
    >`
      SELECT MAX(revision)::text AS revision
      FROM billing_metering_rate_revision
      WHERE tenant_id = ${draft.tenantId}`;
    const previous = maxima[0]?.revision;
    const revision =
      previous === null || previous === undefined ? 1n : BigInt(previous) + 1n;
    if (revision > MAX_REVISION)
      throw new MeteringError(
        "METERING_PUBLICATION_REVISION_EXHAUSTED",
        "Metering publication revision is exhausted",
      );
    const clocks = await client.$queryRaw<readonly { published_at: Date }[]>`
      SELECT CURRENT_TIMESTAMP(3) AS published_at`;
    const publishedAt = clocks[0]?.published_at;
    if (
      !(publishedAt instanceof Date) ||
      !Number.isFinite(publishedAt.getTime())
    )
      throw new MeteringError(
        "METERING_PUBLICATION_UNAVAILABLE",
        "Metering publication is unavailable",
      );
    const revisionId = randomUUID();
    await client.billing_metering_rate_revision.create({
      data: {
        id: revisionId,
        tenant_id: draft.tenantId,
        revision,
        schema_version: 1,
        effective_from: new Date(draft.effectiveFrom),
        source_ref: draft.sourceRef,
        verified_at: new Date(draft.verifiedAt),
        profile_version: draft.profileRef.version,
        profile_artifact_digest: draft.profileRef.artifactDigest,
        content_digest: contentDigest,
        rate_count: draft.rates.length,
        published_at: publishedAt,
      },
    });
    await client.billing_metering_rate.createMany({
      data: draft.rates.map((rate, ordinal) => ({
        id: randomUUID(),
        tenant_id: draft.tenantId,
        revision,
        ordinal,
        provider_ref: rate.providerRef,
        environment: rate.environment,
        pricing_account_ref: rate.pricingAccountRef,
        model_ref: rate.modelRef,
        model_version: rate.modelVersion,
        bucket: rate.bucket,
        unit: rate.unit,
        applicability_kind: rate.applicability.kind,
        dimension:
          rate.applicability.kind === "range"
            ? rate.applicability.dimension
            : null,
        applicability_unit:
          rate.applicability.kind === "range" ? rate.applicability.unit : null,
        lower_inclusive:
          rate.applicability.kind === "range"
            ? BigInt(rate.applicability.lowerInclusive)
            : null,
        upper_exclusive:
          rate.applicability.kind === "range" &&
          rate.applicability.upperExclusive !== null
            ? BigInt(rate.applicability.upperExclusive)
            : null,
        currency_code: rate.currencyCode,
        minor_per_unit_numerator: rate.minorPerUnit.numerator,
        minor_per_unit_denominator: rate.minorPerUnit.denominator,
        business_key_digest: keyDigest(rate),
      })),
    });
    return {
      revisionId,
      result: {
        schemaVersion: 1,
        kind: "rate",
        tenantId: draft.tenantId,
        revision: revision.toString(),
        contentDigest,
        publishedAt: publishedAt.toISOString(),
        effectiveFrom: draft.effectiveFrom,
      },
    };
  }

  async assertRatePublication(
    expected: MeteringPricingPublicationResultV1,
    draft: MeteringRateRevisionDraft,
  ): Promise<void> {
    const encodedDraft = encodeMeteringRateRevisionDraft(draft);
    if (
      expected.tenantId !== draft.tenantId ||
      expected.effectiveFrom !== draft.effectiveFrom ||
      expected.contentDigest !== encodedDraft.contentDigest
    )
      this.#corrupt();
    const stored = await this.#readRateRevision(
      expected.tenantId,
      BigInt(expected.revision),
      () => this.#corrupt(),
    );
    if (
      stored.revisionId.length === 0 ||
      stored.draft.effectiveFrom !== expected.effectiveFrom ||
      stored.contentDigest !== expected.contentDigest ||
      stored.publishedAt !== expected.publishedAt ||
      encodeMeteringRateRevisionDraft(stored.draft).canonicalJson !==
        encodedDraft.canonicalJson
    )
      this.#corrupt();
  }

  async selectActivePricing(
    input: MeteringPricingSelectionInput,
  ): Promise<MeteringPricingSelectionResult> {
    const client = this.transactions.requireActiveTransaction(
      input.tenantId,
      "write",
    );
    const clocks = await client.$queryRaw<readonly { db_now: Date }[]>`
      SELECT CURRENT_TIMESTAMP(3) AS db_now`;
    const dbNow = clocks[0]?.db_now;
    if (!(dbNow instanceof Date) || !Number.isFinite(dbNow.getTime()))
      this.#selectionCorrupt();
    const selected = await client.$queryRaw<
      readonly { id: string; revision: bigint }[]
    >`
      SELECT id,revision FROM billing_metering_rate_revision
      WHERE tenant_id=${input.tenantId} AND effective_from <= ${dbNow}
      ORDER BY effective_from DESC,revision DESC LIMIT 1`;
    const active = selected[0];
    if (!active)
      throw new MeteringError(
        "METERING_RATE_UNAVAILABLE",
        "Metering rate is unavailable",
      );
    const stored = await this.#readRateRevision(
      input.tenantId,
      active.revision,
      () => this.#selectionCorrupt(),
    );
    if (stored.revisionId !== active.id) this.#selectionCorrupt();
    if (
      stored.draft.profileRef.version !== input.profileRef.version ||
      stored.draft.profileRef.artifactDigest !== input.profileRef.artifactDigest
    )
      throw new MeteringError(
        "METERING_RATE_UNAVAILABLE",
        "Metering rate is unavailable",
      );
    const bindingRates = stored.draft.rates.filter(
      (rate) =>
        rate.providerRef === input.binding.providerRef &&
        rate.environment === input.binding.environment &&
        rate.pricingAccountRef === input.binding.pricingAccountRef &&
        rate.modelRef === input.binding.modelRef &&
        rate.modelVersion === input.binding.modelVersion,
    );
    const currencies = new Set(bindingRates.map((rate) => rate.currencyCode));
    if (currencies.size > 1) this.#selectionCorrupt();
    const rates = input.requests.map((request) => {
      const matches = bindingRates.filter((rate) => {
        if (rate.bucket !== request.bucket || rate.unit !== request.unit)
          return false;
        if (rate.applicability.kind === "all") return true;
        return (
          request.applicability.kind === "range" &&
          rate.applicability.dimension === request.applicability.dimension &&
          rate.applicability.unit === request.applicability.unit &&
          BigInt(request.applicability.value) >=
            BigInt(rate.applicability.lowerInclusive) &&
          (rate.applicability.upperExclusive === null ||
            BigInt(request.applicability.value) <
              BigInt(rate.applicability.upperExclusive))
        );
      });
      if (matches.length === 0)
        throw new MeteringError(
          "METERING_RATE_UNAVAILABLE",
          "Metering rate is unavailable",
        );
      if (matches.length > 1)
        throw new MeteringError(
          "METERING_RATE_AMBIGUOUS",
          "Metering rate is ambiguous",
        );
      const rate = matches[0];
      if (!rate) this.#selectionCorrupt();
      return Object.freeze({ request, rate });
    });
    const currencyCode = rates[0]?.rate.currencyCode;
    if (
      !currencyCode ||
      rates.some((item) => item.rate.currencyCode !== currencyCode)
    )
      this.#selectionCorrupt();
    const selectedPolicies = await client.$queryRaw<
      readonly { id: string; revision: bigint }[]
    >`
      SELECT id,revision FROM billing_metering_policy_revision
      WHERE tenant_id=${input.tenantId} AND effective_from <= ${dbNow}
      ORDER BY effective_from DESC,revision DESC LIMIT 1`;
    const activePolicy = selectedPolicies[0];
    if (!activePolicy)
      throw new MeteringError(
        "METERING_POLICY_UNAVAILABLE",
        "Metering policy is unavailable",
      );
    const policy = await this.#readPolicyRevision(
      input.tenantId,
      activePolicy.revision,
    );
    if (policy.revisionId !== activePolicy.id) this.#policyCorrupt();
    if (
      policy.draft.profileRef.version !== input.profileRef.version ||
      policy.draft.profileRef.artifactDigest !==
        input.profileRef.artifactDigest ||
      policy.draft.currencyCode !== currencyCode
    )
      throw new MeteringError(
        "METERING_POLICY_UNAVAILABLE",
        "Metering policy is unavailable",
      );
    const failurePolicyRef = policy.draft.failurePolicyRef;
    if (failurePolicyRef === null) this.#policyCorrupt();
    return Object.freeze({
      tenantId: input.tenantId,
      dbNow: dbNow.toISOString(),
      revisionId: stored.revisionId,
      revision: active.revision.toString(),
      effectiveFrom: stored.draft.effectiveFrom,
      contentDigest: stored.contentDigest,
      profileRef: Object.freeze({ ...stored.draft.profileRef }),
      currencyCode,
      rates: Object.freeze(rates),
      policy: Object.freeze({
        revisionId: policy.revisionId,
        revision: activePolicy.revision.toString(),
        contentDigest: policy.contentDigest,
        effectiveFrom: policy.draft.effectiveFrom,
        multiplier: Object.freeze({ ...policy.draft.multiplier }),
        creditMicrosPerMinor: Object.freeze({
          ...policy.draft.creditMicrosPerMinor,
        }),
        roundingVersion: policy.draft.roundingVersion,
        failurePolicyRef: Object.freeze({ ...failurePolicyRef }),
      }),
    });
  }

  async publishPolicy(
    draft: MeteringPolicyRevisionDraft,
    contentDigest: string,
  ): Promise<MeteringPricingPublicationEffect<"policy">> {
    const client = this.transactions.requireActiveTransaction(
      draft.tenantId,
      "write",
    );
    const lock = `metering:pricing-generation:policy:${draft.tenantId}`;
    await client.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    const maxima = await client.$queryRaw<
      readonly { revision: string | null }[]
    >`
      SELECT MAX(revision)::text AS revision FROM billing_metering_policy_revision
      WHERE tenant_id=${draft.tenantId}`;
    const previous = maxima[0]?.revision;
    const revision =
      previous === null || previous === undefined ? 1n : BigInt(previous) + 1n;
    if (revision > MAX_REVISION)
      throw new MeteringError(
        "METERING_PUBLICATION_REVISION_EXHAUSTED",
        "Metering publication revision is exhausted",
      );
    const clocks = await client.$queryRaw<readonly { published_at: Date }[]>`
      SELECT CURRENT_TIMESTAMP(3) AS published_at`;
    const publishedAt = clocks[0]?.published_at;
    if (
      !(publishedAt instanceof Date) ||
      !Number.isFinite(publishedAt.getTime())
    )
      throw new MeteringError(
        "METERING_PUBLICATION_UNAVAILABLE",
        "Metering publication is unavailable",
      );
    const failurePolicyRef = draft.failurePolicyRef;
    if (failurePolicyRef === null) this.#policyCorrupt();
    const revisionId = randomUUID();
    await client.billing_metering_policy_revision.create({
      data: {
        id: revisionId,
        tenant_id: draft.tenantId,
        revision,
        schema_version: 1,
        effective_from: new Date(draft.effectiveFrom),
        source_ref: draft.sourceRef,
        verified_at: new Date(draft.verifiedAt),
        profile_version: draft.profileRef.version,
        profile_artifact_digest: draft.profileRef.artifactDigest,
        currency_code: draft.currencyCode,
        multiplier_numerator: draft.multiplier.numerator,
        multiplier_denominator: draft.multiplier.denominator,
        credit_micros_per_minor_numerator: draft.creditMicrosPerMinor.numerator,
        credit_micros_per_minor_denominator:
          draft.creditMicrosPerMinor.denominator,
        rounding_version: draft.roundingVersion,
        failure_policy_version: failurePolicyRef.version,
        failure_policy_artifact_digest: failurePolicyRef.artifactDigest,
        content_digest: contentDigest,
        published_at: publishedAt,
      },
    });
    return {
      revisionId,
      result: {
        schemaVersion: 1,
        kind: "policy",
        tenantId: draft.tenantId,
        revision: revision.toString(),
        contentDigest,
        publishedAt: publishedAt.toISOString(),
        effectiveFrom: draft.effectiveFrom,
      },
    };
  }

  async assertPolicyPublication(
    expected: MeteringPricingPublicationResultV1<"policy">,
    draft: MeteringPolicyRevisionDraft,
  ): Promise<void> {
    const encoded = encodeMeteringPolicyRevisionDraft(draft);
    if (
      expected.kind !== "policy" ||
      expected.tenantId !== draft.tenantId ||
      expected.effectiveFrom !== draft.effectiveFrom ||
      expected.contentDigest !== encoded.contentDigest
    )
      this.#policyCorrupt();
    const stored = await this.#readPolicyRevision(
      expected.tenantId,
      BigInt(expected.revision),
    );
    if (
      stored.contentDigest !== expected.contentDigest ||
      stored.publishedAt !== expected.publishedAt ||
      encodeMeteringPolicyRevisionDraft(stored.draft).canonicalJson !==
        encoded.canonicalJson
    )
      this.#policyCorrupt();
  }

  async #readPolicyRevision(
    tenantId: string,
    revision: bigint,
  ): Promise<
    Readonly<{
      revisionId: string;
      contentDigest: string;
      publishedAt: string;
      draft: MeteringPolicyRevisionDraft;
    }>
  > {
    const client = this.transactions.requireActiveTransaction(
      tenantId,
      "write",
    );
    const row = await client.billing_metering_policy_revision.findUnique({
      where: { tenant_id_revision: { tenant_id: tenantId, revision } },
    });
    if (!row || row.schema_version !== 1) this.#policyCorrupt();
    // Database failures are outside this catch: preserve transaction firstCause.
    try {
      const encoded = encodeMeteringPolicyRevisionDraft({
        schemaVersion: "1",
        tenantId,
        effectiveFrom: row.effective_from.toISOString(),
        sourceRef: row.source_ref,
        verifiedAt: row.verified_at.toISOString(),
        profileRef: {
          version: row.profile_version,
          artifactDigest: row.profile_artifact_digest,
        },
        currencyCode: row.currency_code,
        multiplier: {
          numerator: row.multiplier_numerator.toFixed(0),
          denominator: row.multiplier_denominator.toFixed(0),
        },
        creditMicrosPerMinor: {
          numerator: row.credit_micros_per_minor_numerator.toFixed(0),
          denominator: row.credit_micros_per_minor_denominator.toFixed(0),
        },
        roundingVersion: row.rounding_version,
        failurePolicyRef: {
          version: row.failure_policy_version,
          artifactDigest: row.failure_policy_artifact_digest,
        },
      });
      const draft = decodeMeteringPolicyRevisionDraft(encoded.canonicalJson);
      assertExecutableMeteringPolicy(draft);
      if (encoded.contentDigest !== row.content_digest) this.#policyCorrupt();
      return {
        revisionId: row.id,
        contentDigest: row.content_digest,
        publishedAt: row.published_at.toISOString(),
        draft,
      };
    } catch {
      this.#policyCorrupt();
    }
  }

  #policyCorrupt(): never {
    throw new MeteringError(
      "METERING_POLICY_CORRUPT",
      "Metering policy is corrupt",
    );
  }

  async #readRateRevision(
    tenantId: string,
    revision: bigint,
    corrupt: () => never,
  ): Promise<
    Readonly<{
      revisionId: string;
      contentDigest: string;
      publishedAt: string;
      draft: MeteringRateRevisionDraft;
    }>
  > {
    const client = this.transactions.requireActiveTransaction(
      tenantId,
      "write",
    );
    const header = await client.billing_metering_rate_revision.findUnique({
      where: { tenant_id_revision: { tenant_id: tenantId, revision } },
    });
    const rows = await client.billing_metering_rate.findMany({
      where: { tenant_id: tenantId, revision },
      orderBy: { ordinal: "asc" },
      take: 65,
    });
    if (
      !header ||
      header.schema_version !== 1 ||
      header.rate_count < 1 ||
      header.rate_count > 64 ||
      rows.length !== header.rate_count
    )
      corrupt();
    const reconstructed = rows.map((row, ordinal): MeteringRevisionRate => {
      if (row.ordinal !== ordinal) corrupt();
      let applicability: MeteringRateApplicability;
      if (row.applicability_kind === "all") {
        if (
          row.dimension !== null ||
          row.applicability_unit !== null ||
          row.lower_inclusive !== null ||
          row.upper_exclusive !== null
        )
          corrupt();
        applicability = Object.freeze({ kind: "all" });
      } else if (
        row.applicability_kind === "range" &&
        row.dimension !== null &&
        row.applicability_unit !== null &&
        row.lower_inclusive !== null
      ) {
        applicability = Object.freeze({
          kind: "range",
          dimension: row.dimension,
          unit: row.applicability_unit,
          lowerInclusive: row.lower_inclusive.toString(),
          upperExclusive: row.upper_exclusive?.toString() ?? null,
        });
      } else corrupt();
      const rate: MeteringRevisionRate = Object.freeze({
        providerRef: row.provider_ref,
        environment: row.environment,
        pricingAccountRef: row.pricing_account_ref,
        modelRef: row.model_ref,
        modelVersion: row.model_version,
        bucket: row.bucket,
        unit: row.unit,
        applicability,
        currencyCode: row.currency_code,
        minorPerUnit: Object.freeze({
          numerator: row.minor_per_unit_numerator.toFixed(0),
          denominator: row.minor_per_unit_denominator.toFixed(0),
        }),
      });
      if (row.business_key_digest !== keyDigest(rate)) corrupt();
      return rate;
    });
    const draft: MeteringRateRevisionDraft = Object.freeze({
      schemaVersion: "1",
      tenantId,
      effectiveFrom: header.effective_from.toISOString(),
      sourceRef: header.source_ref,
      verifiedAt: header.verified_at.toISOString(),
      profileRef: Object.freeze({
        version: header.profile_version,
        artifactDigest: header.profile_artifact_digest,
      }),
      rates: Object.freeze(reconstructed),
    });
    let reconstructedDigest: string;
    try {
      reconstructedDigest =
        encodeMeteringRateRevisionDraft(draft).contentDigest;
    } catch {
      corrupt();
    }
    if (reconstructedDigest !== header.content_digest) corrupt();
    return Object.freeze({
      revisionId: header.id,
      contentDigest: header.content_digest,
      publishedAt: header.published_at.toISOString(),
      draft,
    });
  }

  #selectionCorrupt(): never {
    throw new MeteringError(
      "METERING_RATE_CORRUPT",
      "Metering rate is corrupt",
    );
  }

  #corrupt(): never {
    throw new MeteringError(
      "METERING_PUBLICATION_CORRUPT",
      "Metering publication is corrupt",
    );
  }
}
