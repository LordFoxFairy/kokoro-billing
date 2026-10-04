import { createHash, randomUUID } from "node:crypto";
import type { TransactionService } from "../../database/transaction.service.js";
import { encodeMeteringRateRevisionDraft } from "./metering-pricing-revision-codec.js";
import type {
  MeteringRateApplicability,
  MeteringRateRevisionDraft,
  MeteringRevisionRate,
} from "./metering-pricing-revision.types.js";
import type { MeteringPricingPublicationResultV1 } from "./metering-pricing-publication-result-codec.js";
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

export type MeteringRatePublicationEffect = Readonly<{
  revisionId: string;
  result: MeteringPricingPublicationResultV1;
}>;

export class MeteringPricingRevisionRepository {
  constructor(private readonly transactions: TransactionService) {}

  async publishRate(
    draft: MeteringRateRevisionDraft,
    contentDigest: string,
  ): Promise<MeteringRatePublicationEffect> {
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
    const client = this.transactions.requireActiveTransaction(
      draft.tenantId,
      "write",
    );
    const revision = BigInt(expected.revision);
    const header = await client.billing_metering_rate_revision.findUnique({
      where: {
        tenant_id_revision: { tenant_id: expected.tenantId, revision },
      },
    });
    const rows = await client.billing_metering_rate.findMany({
      where: { tenant_id: expected.tenantId, revision },
      orderBy: { ordinal: "asc" },
      take: 65,
    });
    if (
      !header ||
      header.schema_version !== 1 ||
      header.effective_from.toISOString() !== expected.effectiveFrom ||
      header.source_ref !== draft.sourceRef ||
      header.verified_at.toISOString() !== draft.verifiedAt ||
      header.profile_version !== draft.profileRef.version ||
      header.profile_artifact_digest !== draft.profileRef.artifactDigest ||
      header.content_digest !== expected.contentDigest ||
      header.published_at.toISOString() !== expected.publishedAt ||
      header.rate_count !== draft.rates.length ||
      rows.length !== draft.rates.length
    )
      this.#corrupt();
    const reconstructed = rows.map((row, ordinal): MeteringRevisionRate => {
      if (row.ordinal !== ordinal) this.#corrupt();
      let applicability: MeteringRateApplicability;
      if (row.applicability_kind === "all") {
        if (
          row.dimension !== null ||
          row.applicability_unit !== null ||
          row.lower_inclusive !== null ||
          row.upper_exclusive !== null
        )
          this.#corrupt();
        applicability = { kind: "all" };
      } else if (
        row.applicability_kind === "range" &&
        row.dimension !== null &&
        row.applicability_unit !== null &&
        row.lower_inclusive !== null
      ) {
        applicability = {
          kind: "range",
          dimension: row.dimension,
          unit: row.applicability_unit,
          lowerInclusive: row.lower_inclusive.toString(),
          upperExclusive: row.upper_exclusive?.toString() ?? null,
        };
      } else this.#corrupt();
      const rate: MeteringRevisionRate = {
        providerRef: row.provider_ref,
        environment: row.environment,
        pricingAccountRef: row.pricing_account_ref,
        modelRef: row.model_ref,
        modelVersion: row.model_version,
        bucket: row.bucket,
        unit: row.unit,
        applicability,
        currencyCode: row.currency_code,
        minorPerUnit: {
          numerator: row.minor_per_unit_numerator.toFixed(0),
          denominator: row.minor_per_unit_denominator.toFixed(0),
        },
      };
      if (row.business_key_digest !== keyDigest(rate)) this.#corrupt();
      return rate;
    });
    const canonicalDraft: MeteringRateRevisionDraft = {
      schemaVersion: "1",
      tenantId: expected.tenantId,
      effectiveFrom: expected.effectiveFrom,
      sourceRef: header.source_ref,
      verifiedAt: header.verified_at.toISOString(),
      profileRef: {
        version: header.profile_version,
        artifactDigest: header.profile_artifact_digest,
      },
      rates: reconstructed,
    };
    if (
      encodeMeteringRateRevisionDraft(canonicalDraft).contentDigest !==
        expected.contentDigest ||
      encodeMeteringRateRevisionDraft(canonicalDraft).canonicalJson !==
        encodedDraft.canonicalJson
    )
      this.#corrupt();
  }

  #corrupt(): never {
    throw new MeteringError(
      "METERING_PUBLICATION_CORRUPT",
      "Metering publication is corrupt",
    );
  }
}
