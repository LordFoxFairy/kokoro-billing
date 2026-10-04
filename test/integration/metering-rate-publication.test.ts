import { createHash, randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DatabaseModule } from "../../src/database/database.module.js";
import type { BillingAdminContext } from "../../src/infrastructure/auth/billing-auth.types.js";
import { MeteringPricingPublicationService } from "../../src/modules/metering/metering-pricing-publication.service.js";
import { encodeMeteringRateRevisionDraft } from "../../src/modules/metering/metering-pricing-revision-codec.js";
import type {
  MeteringPublicationCommand,
  MeteringRateRevisionDraft,
} from "../../src/modules/metering/metering-pricing-revision.types.js";
import { MeteringModule } from "../../src/modules/metering/metering.module.js";
import { assertDefined } from "../assert-defined.js";
import {
  createPrismaDatabaseFixture,
  type PrismaDatabaseFixture,
} from "./prisma-database.fixture.js";

const adminUrl = process.env.SCHEMA_ADMIN_URL;
const integration = describe.skipIf(adminUrl === undefined);
const DOMAIN = "kokoro.billing.metering.rate.key.v1";
const MAX_BIGINT = "9223372036854775807";
const MAX_NUMERIC_78 = "9".repeat(78);
const COPRIME_NUMERIC_78 = (BigInt(MAX_NUMERIC_78) - 1n).toString();

const fourByteText = (field: string, length: number) => {
  const characters: string[] = [];
  for (let ordinal = 0; ordinal < length; ordinal++) {
    const bytes = createHash("sha256")
      .update(`${DOMAIN}:qa-boundary:${field}:${ordinal}`, "utf8")
      .digest();
    const codePoint = 0x10_000 + (bytes.readUInt32BE(0) % 0x10_0000);
    characters.push(String.fromCodePoint(codePoint));
  }
  return characters.join("");
};

const digest = (tuple: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");

const rateKeyDigest = (input: {
  providerRef: string;
  environment: string;
  pricingAccountRef: string;
  modelRef: string;
  modelVersion: string;
  bucket: string;
  unit: string;
  applicability:
    | readonly ["all"]
    | readonly ["range", string, string, string, string | null];
}) =>
  digest([
    DOMAIN,
    input.providerRef,
    input.environment,
    input.pricingAccountRef,
    input.modelRef,
    input.modelVersion,
    input.bucket,
    input.unit,
    input.applicability,
  ]);

type RateRow = Readonly<{
  tenantId: string;
  revision: string;
  ordinal: number;
  providerRef: string;
  environment: string;
  pricingAccountRef: string;
  modelRef: string;
  modelVersion: string;
  bucket: string;
  unit: string;
  applicabilityKind: "all" | "range";
  dimension: string | null;
  applicabilityUnit: string | null;
  lowerInclusive: string | null;
  upperExclusive: string | null;
  currencyCode: string;
  numerator: string;
  denominator: string;
  businessKeyDigest: string;
}>;

const ordinaryRate = (tenantId: string, revision = "1"): RateRow => ({
  tenantId,
  revision,
  ordinal: 0,
  providerRef: "provider",
  environment: "test",
  pricingAccountRef: "pricing-account",
  modelRef: "model",
  modelVersion: "v1",
  bucket: "input",
  unit: "token",
  applicabilityKind: "all",
  dimension: null,
  applicabilityUnit: null,
  lowerInclusive: null,
  upperExclusive: null,
  currencyCode: "USD",
  numerator: "7",
  denominator: "5",
  businessKeyDigest: rateKeyDigest({
    providerRef: "provider",
    environment: "test",
    pricingAccountRef: "pricing-account",
    modelRef: "model",
    modelVersion: "v1",
    bucket: "input",
    unit: "token",
    applicability: ["all"],
  }),
});

integration("R224 immutable metering rate canonical schema", () => {
  let fixture: PrismaDatabaseFixture | undefined;

  beforeEach(async () => {
    fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  const pool = () => assertDefined(fixture).pool;

  const insertRevision = async (
    tenantId: string,
    revision = "1",
    profileVersion = "usage-v1",
    rateCount = 1,
    overrides: Readonly<{
      sourceRef?: string;
      profileDigest?: string;
      contentDigest?: string;
    }> = {},
  ) =>
    pool().query(
      `INSERT INTO billing_metering_rate_revision
       (id,tenant_id,revision,schema_version,effective_from,source_ref,verified_at,
        profile_version,profile_artifact_digest,content_digest,rate_count,published_at)
       VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        tenantId,
        revision,
        "2026-10-04T12:00:00.000Z",
        overrides.sourceRef ??
          "QA synthetic fixture; not a production procurement price",
        "2026-10-04T11:00:00.000Z",
        profileVersion,
        overrides.profileDigest ?? "a".repeat(64),
        overrides.contentDigest ?? "b".repeat(64),
        rateCount,
        "2026-10-04T12:30:00.000Z",
      ],
    );

  const insertRate = async (row: RateRow) =>
    pool().query(
      `INSERT INTO billing_metering_rate
       (id,tenant_id,revision,ordinal,provider_ref,environment,pricing_account_ref,
        model_ref,model_version,bucket,unit,applicability_kind,dimension,
        applicability_unit,lower_inclusive,upper_exclusive,currency_code,
        minor_per_unit_numerator,minor_per_unit_denominator,business_key_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        randomUUID(),
        row.tenantId,
        row.revision,
        row.ordinal,
        row.providerRef,
        row.environment,
        row.pricingAccountRef,
        row.modelRef,
        row.modelVersion,
        row.bucket,
        row.unit,
        row.applicabilityKind,
        row.dimension,
        row.applicabilityUnit,
        row.lowerInclusive,
        row.upperExclusive,
        row.currencyCode,
        row.numerator,
        row.denominator,
        row.businessKeyDigest,
      ],
    );

  test("fresh install exposes the exact ordinary columns, checks, and narrow indexes", async () => {
    const columns = await pool().query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT table_name,column_name,data_type,is_nullable,
              character_maximum_length,numeric_precision,numeric_scale
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name IN ('billing_metering_rate_revision','billing_metering_rate')
        ORDER BY table_name,ordinal_position`,
    );
    expect(
      columns.rows,
      "both canonical rate tables and columns are required",
    ).toEqual(
      [
        ["billing_metering_rate", "id", "uuid", "NO", null, null, null],
        [
          "billing_metering_rate",
          "tenant_id",
          "character varying",
          "NO",
          191,
          null,
          null,
        ],
        ["billing_metering_rate", "revision", "bigint", "NO", null, 64, 0],
        ["billing_metering_rate", "ordinal", "smallint", "NO", null, 16, 0],
        [
          "billing_metering_rate",
          "provider_ref",
          "character varying",
          "NO",
          255,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "environment",
          "character varying",
          "NO",
          255,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "pricing_account_ref",
          "character varying",
          "NO",
          255,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "model_ref",
          "character varying",
          "NO",
          255,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "model_version",
          "character varying",
          "NO",
          255,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "bucket",
          "character varying",
          "NO",
          128,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "unit",
          "character varying",
          "NO",
          128,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "applicability_kind",
          "character varying",
          "NO",
          16,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "dimension",
          "character varying",
          "YES",
          128,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "applicability_unit",
          "character varying",
          "YES",
          128,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "lower_inclusive",
          "bigint",
          "YES",
          null,
          64,
          0,
        ],
        [
          "billing_metering_rate",
          "upper_exclusive",
          "bigint",
          "YES",
          null,
          64,
          0,
        ],
        [
          "billing_metering_rate",
          "currency_code",
          "character",
          "NO",
          3,
          null,
          null,
        ],
        [
          "billing_metering_rate",
          "minor_per_unit_numerator",
          "numeric",
          "NO",
          null,
          78,
          0,
        ],
        [
          "billing_metering_rate",
          "minor_per_unit_denominator",
          "numeric",
          "NO",
          null,
          78,
          0,
        ],
        [
          "billing_metering_rate",
          "business_key_digest",
          "character",
          "NO",
          64,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "id",
          "uuid",
          "NO",
          null,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "tenant_id",
          "character varying",
          "NO",
          191,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "revision",
          "bigint",
          "NO",
          null,
          64,
          0,
        ],
        [
          "billing_metering_rate_revision",
          "schema_version",
          "integer",
          "NO",
          null,
          32,
          0,
        ],
        [
          "billing_metering_rate_revision",
          "effective_from",
          "timestamp with time zone",
          "NO",
          null,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "source_ref",
          "character varying",
          "NO",
          255,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "verified_at",
          "timestamp with time zone",
          "NO",
          null,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "profile_version",
          "character varying",
          "NO",
          255,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "profile_artifact_digest",
          "character",
          "NO",
          64,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "content_digest",
          "character",
          "NO",
          64,
          null,
          null,
        ],
        [
          "billing_metering_rate_revision",
          "rate_count",
          "smallint",
          "NO",
          null,
          16,
          0,
        ],
        [
          "billing_metering_rate_revision",
          "published_at",
          "timestamp with time zone",
          "NO",
          null,
          null,
          null,
        ],
      ].map(
        ([
          table_name,
          column_name,
          data_type,
          is_nullable,
          character_maximum_length,
          numeric_precision,
          numeric_scale,
        ]) => ({
          table_name,
          column_name,
          data_type,
          is_nullable,
          character_maximum_length,
          numeric_precision,
          numeric_scale,
        }),
      ),
    );

    const checks = await pool().query<{
      table_name: string;
      name: string;
      definition: string;
    }>(
      `SELECT c.relname AS table_name,k.conname AS name,
              pg_get_constraintdef(k.oid,false) AS definition
         FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        WHERE c.relnamespace='public'::regnamespace
          AND c.relname IN ('billing_metering_rate_revision','billing_metering_rate')
          AND k.contype='c' ORDER BY c.relname,k.conname`,
    );
    const normalizeCheck = (definition: string) =>
      definition
        .split(/('(?:''|[^'])*')/gu)
        .map((fragment, index) =>
          index % 2 === 1
            ? fragment
            : fragment
                .toLowerCase()
                .replace(/::(?:text|bigint|numeric|integer|smallint)/gu, "")
                .replaceAll('"', "")
                .replace(/[\s()]/gu, ""),
        )
        .join("");
    const expectedCheckTerms: Readonly<Record<string, readonly string[]>> = {
      "billing_metering_rate.ck_billing_metering_rate_applicability": [
        "applicability_kind",
        "'all'",
        "'range'",
        "dimensionisnull",
        "dimension~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'",
        "applicability_unitisnull",
        "applicability_unit~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'",
        "lower_inclusiveisnull",
        "upper_exclusiveisnull",
        "lower_inclusive>=0",
        "upper_exclusive>lower_inclusive",
      ],
      "billing_metering_rate.ck_billing_metering_rate_business_key_digest": [
        "business_key_digest~'^[0-9a-f]{64}$'",
      ],
      "billing_metering_rate.ck_billing_metering_rate_business_keys": [
        "char_length(provider_ref)>=1",
        "char_length(provider_ref)<=255",
        "char_length(environment)>=1",
        "char_length(environment)<=255",
        "char_length(pricing_account_ref)>=1",
        "char_length(pricing_account_ref)<=255",
        "char_length(model_ref)>=1",
        "char_length(model_ref)<=255",
        "char_length(model_version)>=1",
        "char_length(model_version)<=255",
        "bucket~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'",
        "unit~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'",
      ],
      "billing_metering_rate.ck_billing_metering_rate_currency": [
        "currency_code~'^[A-Z]{3}$'",
      ],
      "billing_metering_rate.ck_billing_metering_rate_ordinal": [
        "ordinal>=0",
        "ordinal<=63",
      ],
      "billing_metering_rate.ck_billing_metering_rate_price": [
        "minor_per_unit_numerator>=0",
        "minor_per_unit_denominator>0",
      ],
      "billing_metering_rate.ck_billing_metering_rate_revision": ["revision>0"],
      "billing_metering_rate_revision.ck_billing_metering_rate_revision_content_digest":
        ["content_digest~'^[0-9a-f]{64}$'"],
      "billing_metering_rate_revision.ck_billing_metering_rate_revision_count":
        ["rate_count>=1", "rate_count<=64"],
      "billing_metering_rate_revision.ck_billing_metering_rate_revision_number":
        ["revision>0"],
      "billing_metering_rate_revision.ck_billing_metering_rate_revision_profile_digest":
        ["profile_artifact_digest~'^[0-9a-f]{64}$'"],
      "billing_metering_rate_revision.ck_billing_metering_rate_revision_schema":
        ["schema_version=1"],
      "billing_metering_rate_revision.ck_billing_metering_rate_revision_text": [
        "char_length(source_ref)>=1",
        "char_length(source_ref)<=255",
        "char_length(profile_version)>=1",
        "char_length(profile_version)<=255",
      ],
    };
    expect(
      checks.rows.map(({ table_name, name }) => `${table_name}.${name}`),
    ).toEqual(Object.keys(expectedCheckTerms));
    for (const row of checks.rows) {
      const name = `${row.table_name}.${row.name}`;
      const normalized = normalizeCheck(row.definition);
      expect(normalized, `${name} must not be a vacuous CHECK`).not.toBe(
        normalizeCheck("CHECK (TRUE)"),
      );
      for (const term of assertDefined(expectedCheckTerms[name]))
        expect(normalized, `${name} must contain ${term}`).toContain(
          normalizeCheck(term),
        );
    }

    const indexes = await pool().query<{
      name: string;
      unique: boolean;
      keys: string[];
      options: number[];
      definition: string;
    }>(
      `SELECT c.relname AS name,i.indisunique AS unique,pg_get_indexdef(i.indexrelid) AS definition,
              ARRAY(SELECT option::int FROM unnest(i.indoption) WITH ORDINALITY o(option,ord)
                    WHERE o.ord<=i.indnkeyatts ORDER BY o.ord) AS options,
              ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
                    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                   WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS keys
         FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE i.indrelid IN ('public.billing_metering_rate_revision'::regclass,
                             'public.billing_metering_rate'::regclass)
          AND NOT EXISTS (SELECT 1 FROM pg_constraint p
                           WHERE p.conindid=i.indexrelid AND p.contype='p')
        ORDER BY c.relname`,
    );
    expect(
      indexes.rows.map(({ name, unique, keys, options }) => ({
        name,
        unique,
        keys,
        options,
      })),
    ).toEqual([
      {
        name: "ix_billing_metering_rate_revision_effective",
        unique: false,
        keys: ["tenant_id", "effective_from", "revision"],
        options: [0, 3, 3],
      },
      {
        name: "uq_billing_metering_rate_business_key",
        unique: true,
        keys: ["tenant_id", "revision", "business_key_digest"],
        options: [0, 0, 0],
      },
      {
        name: "uq_billing_metering_rate_ordinal",
        unique: true,
        keys: ["tenant_id", "revision", "ordinal"],
        options: [0, 0, 0],
      },
      {
        name: "uq_billing_metering_rate_revision_number",
        unique: true,
        keys: ["tenant_id", "revision"],
        options: [0, 0],
      },
    ]);
    const effective = assertDefined(
      indexes.rows.find(
        ({ name }) => name === "ix_billing_metering_rate_revision_effective",
      ),
    );
    expect(effective.definition.replace(/\s+/gu, " ")).toMatch(
      /USING btree \(tenant_id, effective_from DESC, revision DESC\)$/u,
    );
    const indexedColumns = indexes.rows.flatMap(({ keys }) => keys);
    for (const forbidden of [
      "provider_ref",
      "environment",
      "pricing_account_ref",
      "model_ref",
      "model_version",
    ])
      expect(indexedColumns).not.toContain(forbidden);
  });

  test("accepts the maximum legal Unicode business key and exact BIGINT/NUMERIC boundaries", async () => {
    const providerRef = fourByteText("provider", 255);
    const environment = fourByteText("environment", 255);
    const pricingAccountRef = fourByteText("pricing-account", 255);
    const modelRef = fourByteText("model", 255);
    const modelVersion = fourByteText("model-version", 255);
    const profileVersion = fourByteText("profile", 255);
    const key128 = "A".repeat(128);
    await insertRevision("tenant-max", MAX_BIGINT, profileVersion);
    const applicability = ["range", key128, key128, MAX_BIGINT, null] as const;
    const row: RateRow = {
      tenantId: "tenant-max",
      revision: MAX_BIGINT,
      ordinal: 63,
      providerRef,
      environment,
      pricingAccountRef,
      modelRef,
      modelVersion,
      bucket: key128,
      unit: key128,
      applicabilityKind: "range",
      dimension: key128,
      applicabilityUnit: key128,
      lowerInclusive: MAX_BIGINT,
      upperExclusive: null,
      currencyCode: "USD",
      numerator: MAX_NUMERIC_78,
      denominator: COPRIME_NUMERIC_78,
      businessKeyDigest: rateKeyDigest({
        providerRef,
        environment,
        pricingAccountRef,
        modelRef,
        modelVersion,
        bucket: key128,
        unit: key128,
        applicability,
      }),
    };
    expect(() =>
      encodeMeteringRateRevisionDraft({
        schemaVersion: "1",
        tenantId: "tenant-max",
        effectiveFrom: "2026-10-04T12:00:00.000Z",
        sourceRef: "QA synthetic fixture; not a production procurement price",
        verifiedAt: "2026-10-04T11:00:00.000Z",
        profileRef: {
          version: profileVersion,
          artifactDigest: "a".repeat(64),
        },
        rates: [
          {
            providerRef,
            environment,
            pricingAccountRef,
            modelRef,
            modelVersion,
            bucket: key128,
            unit: key128,
            applicability: {
              kind: "range",
              dimension: key128,
              unit: key128,
              lowerInclusive: MAX_BIGINT,
              upperExclusive: null,
            },
            currencyCode: "USD",
            minorPerUnit: {
              numerator: MAX_NUMERIC_78,
              denominator: COPRIME_NUMERIC_78,
            },
          },
        ],
      }),
    ).not.toThrow();
    expect(await insertRate(row)).toMatchObject({ rowCount: 1 });
    const stored = await pool().query<{
      bytes: number;
      numerator: string;
      denominator: string;
      digest: string;
    }>(
      `SELECT octet_length(provider_ref)+octet_length(environment)+
              octet_length(pricing_account_ref)+octet_length(model_ref)+
              octet_length(model_version) AS bytes,
              minor_per_unit_numerator::text AS numerator,
              minor_per_unit_denominator::text AS denominator,
              business_key_digest AS digest
         FROM billing_metering_rate WHERE tenant_id=$1 AND revision=$2`,
      ["tenant-max", MAX_BIGINT],
    );
    expect(stored.rows).toEqual([
      {
        bytes: 5_100,
        numerator: MAX_NUMERIC_78,
        denominator: COPRIME_NUMERIC_78,
        digest: row.businessKeyDigest,
      },
    ]);
  });

  test("enforces all/range shape, positive revision, ordinal, and numeric bounds", async () => {
    await insertRevision("tenant-checks");
    const base = ordinaryRate("tenant-checks");
    for (const invalid of [
      { ...base, dimension: "illegal" },
      { ...base, applicabilityUnit: "token" },
      { ...base, lowerInclusive: "0" },
      { ...base, upperExclusive: "1" },
    ])
      await expect(insertRate(invalid)).rejects.toMatchObject({
        code: "23514",
        constraint: "ck_billing_metering_rate_applicability",
      });
    await expect(
      pool().query(
        `INSERT INTO billing_metering_rate
         (id,tenant_id,revision,ordinal,provider_ref,environment,pricing_account_ref,
          model_ref,model_version,bucket,unit,applicability_kind,dimension,
          applicability_unit,lower_inclusive,upper_exclusive,currency_code,
          minor_per_unit_numerator,minor_per_unit_denominator,business_key_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          randomUUID(),
          base.tenantId,
          base.revision,
          base.ordinal,
          base.providerRef,
          base.environment,
          base.pricingAccountRef,
          base.modelRef,
          base.modelVersion,
          base.bucket,
          base.unit,
          "invalid",
          base.dimension,
          base.applicabilityUnit,
          base.lowerInclusive,
          base.upperExclusive,
          base.currencyCode,
          base.numerator,
          base.denominator,
          base.businessKeyDigest,
        ],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_applicability",
    });
    await expect(
      insertRate({
        ...base,
        applicabilityKind: "range",
        dimension: "tokens",
        applicabilityUnit: "token",
        lowerInclusive: "10",
        upperExclusive: "10",
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_applicability",
    });
    await expect(insertRate({ ...base, ordinal: 64 })).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_ordinal",
    });
    await expect(
      insertRate({ ...base, denominator: "0" }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_price",
    });
    await expect(
      insertRate({ ...base, numerator: "-1" }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_price",
    });
    await expect(
      insertRate({ ...base, bucket: "invalid key" }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_business_keys",
    });
    await expect(
      insertRate({ ...base, providerRef: "" }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_business_keys",
    });
    await expect(
      insertRate({ ...base, currencyCode: "usd" }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_currency",
    });
    await expect(
      insertRate({ ...base, businessKeyDigest: "A".repeat(64) }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_business_key_digest",
    });
    for (const invalid of [
      {
        ...base,
        applicabilityKind: "range" as const,
        dimension: null,
        applicabilityUnit: "TOKEN",
        lowerInclusive: "0",
      },
      {
        ...base,
        applicabilityKind: "range" as const,
        dimension: "TOKENS",
        applicabilityUnit: null,
        lowerInclusive: "0",
      },
      {
        ...base,
        applicabilityKind: "range" as const,
        dimension: "TOKENS",
        applicabilityUnit: "TOKEN",
        lowerInclusive: null,
      },
    ])
      await expect(insertRate(invalid)).rejects.toMatchObject({
        code: "23514",
        constraint: "ck_billing_metering_rate_applicability",
      });
    await expect(
      insertRate({
        ...base,
        applicabilityKind: "range",
        dimension: "tokens",
        applicabilityUnit: "token",
        lowerInclusive: "-1",
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_applicability",
    });
    await expect(
      insertRevision("tenant-count-zero", "1", "usage-v1", 0),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_revision_count",
    });
    await expect(
      insertRevision("tenant-count-over", "1", "usage-v1", 65),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_revision_count",
    });
    await expect(
      insertRevision("tenant-empty-source", "1", "usage-v1", 1, {
        sourceRef: "",
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_revision_text",
    });
    await expect(
      insertRevision("tenant-empty-profile", "1", "", 1),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_revision_text",
    });
    await expect(
      insertRevision("tenant-profile-digest", "1", "usage-v1", 1, {
        profileDigest: "A".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_revision_profile_digest",
    });
    await expect(
      insertRevision("tenant-content-digest", "1", "usage-v1", 1, {
        contentDigest: "g".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_revision_content_digest",
    });
    await expect(insertRevision("tenant-zero", "0")).rejects.toMatchObject({
      code: "23514",
      constraint: "ck_billing_metering_rate_revision_number",
    });
    await expect(
      insertRevision("tenant-overflow", "9223372036854775808"),
    ).rejects.toMatchObject({ code: "22003" });
    await expect(
      insertRate({ ...base, numerator: `1${"0".repeat(78)}` }),
    ).rejects.toMatchObject({ code: "22003" });
  });

  test("scopes revision, ordinal, and digest uniqueness by tenant", async () => {
    await insertRevision("tenant-a");
    await insertRevision("tenant-b");
    const first = ordinaryRate("tenant-a");
    await insertRate(first);
    await expect(insertRate({ ...first, ordinal: 1 })).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_billing_metering_rate_business_key",
    });
    await expect(
      insertRate({
        ...first,
        providerRef: "other-provider",
        businessKeyDigest: "c".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_billing_metering_rate_ordinal",
    });
    await expect(insertRevision("tenant-a")).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_billing_metering_rate_revision_number",
    });
    expect(await insertRate({ ...first, tenantId: "tenant-b" })).toMatchObject({
      rowCount: 1,
    });
  });
});

integration("R227 immutable metering rate publication", () => {
  let fixture: PrismaDatabaseFixture | undefined;
  let application: TestingModule | undefined;
  let service: MeteringPricingPublicationService;

  beforeEach(async () => {
    fixture = await createPrismaDatabaseFixture(assertDefined(adminUrl));
    application = await Test.createTestingModule({
      imports: [
        DatabaseModule.register({ databaseUrl: assertDefined(fixture).url }),
        MeteringModule,
      ],
    }).compile();
    await application.init();
    service = application.get(MeteringPricingPublicationService);
  });

  afterEach(async () => {
    await application?.close();
    application = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  const pool = () => assertDefined(fixture).pool;
  const context = (tenantId = "tenant-publication"): BillingAdminContext => ({
    tenantId,
    operatorId: "operator-publication",
    role: "billing.admin",
  });
  const command = (
    overrides: Partial<
      MeteringPublicationCommand<MeteringRateRevisionDraft>
    > = {},
  ): MeteringPublicationCommand<MeteringRateRevisionDraft> => ({
    tenantId: "tenant-publication",
    actorId: "operator-publication",
    publicationIdentity: "publication-1",
    idempotencyKey: "publication-key-1",
    reason: "QA synthetic publication",
    draft: {
      schemaVersion: "1",
      tenantId: "tenant-publication",
      effectiveFrom: "2026-10-04T12:00:00.000Z",
      sourceRef: "QA synthetic fixture; not a production procurement price",
      verifiedAt: "2026-10-04T11:00:00.000Z",
      profileRef: {
        version: "usage-v1",
        artifactDigest: "a".repeat(64),
      },
      rates: [
        {
          providerRef: "Provider-A",
          environment: "Test",
          pricingAccountRef: "Account-A",
          modelRef: "Model-A",
          modelVersion: "V1",
          bucket: "Input.Token",
          unit: "Token",
          applicability: { kind: "all" },
          currencyCode: "USD",
          minorPerUnit: { numerator: "7", denominator: "5" },
        },
      ],
    },
    ...overrides,
  });

  const counts = async () => {
    const result = await pool().query<{
      revisions: string;
      rates: string;
      receipts: string;
      keys: string;
      audits: string;
    }>(`SELECT
      (SELECT count(*)::text FROM billing_metering_rate_revision) AS revisions,
      (SELECT count(*)::text FROM billing_metering_rate) AS rates,
      (SELECT count(*)::text FROM billing_command_receipt WHERE command_name='metering.publish_rate_revision') AS receipts,
      (SELECT count(*)::text FROM billing_command_key_binding WHERE command_name='metering.publish_rate_revision') AS keys,
      (SELECT count(*)::text FROM billing_audit_event WHERE action='metering.publish_rate_revision') AS audits`);
    return assertDefined(result.rows[0]);
  };

  test("publishes one canonical revision and exactly replays it under a new key", async () => {
    const first = await service.publishRate(context(), command());
    const replay = await service.publishRate(
      context(),
      command({ idempotencyKey: "publication-key-2" }),
    );
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      kind: "rate",
      tenantId: "tenant-publication",
      revision: "1",
      effectiveFrom: "2026-10-04T12:00:00.000Z",
      contentDigest: encodeMeteringRateRevisionDraft(command().draft)
        .contentDigest,
    });
    expect(first.publishedAt).toMatch(/\.\d{3}Z$/u);
    expect(await counts()).toEqual({
      revisions: "1",
      rates: "1",
      receipts: "1",
      keys: "2",
      audits: "1",
    });
    const audit = await pool().query<{
      resource_id: string;
      revision_id: string;
    }>(`SELECT a.resource_id::text AS resource_id,r.id::text AS revision_id
          FROM billing_audit_event a
          JOIN billing_metering_rate_revision r ON r.id=a.resource_id
         WHERE a.action='metering.publish_rate_revision'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.resource_id).toBe(audit.rows[0]?.revision_id);
  });

  test("persists and strictly replays the complete 64-row canonical draft", async () => {
    const rates = Array.from({ length: 64 }, (_, index) => ({
      ...assertDefined(command().draft.rates[0]),
      bucket: `Bucket-${index.toString().padStart(2, "0")}`,
      minorPerUnit: { numerator: index.toString(), denominator: "1" },
    }));
    const input = command({ draft: { ...command().draft, rates } });
    const first = await service.publishRate(context(), input);
    const replay = await service.publishRate(
      context(),
      command({
        idempotencyKey: "publication-key-64-replay",
        draft: { ...command().draft, rates: [...rates].reverse() },
      }),
    );
    expect(replay).toEqual(first);
    const stored = await pool().query<{
      count: string;
      minimum_ordinal: number;
      maximum_ordinal: number;
      distinct_digests: string;
    }>(
      `SELECT count(*)::text AS count,
               min(ordinal)::int AS minimum_ordinal,
               max(ordinal)::int AS maximum_ordinal,
               count(DISTINCT business_key_digest)::text AS distinct_digests
          FROM billing_metering_rate
         WHERE tenant_id=$1 AND revision=1`,
      ["tenant-publication"],
    );
    expect(stored.rows).toEqual([
      {
        count: "64",
        minimum_ordinal: 0,
        maximum_ordinal: 63,
        distinct_digests: "64",
      },
    ]);
    expect(await counts()).toMatchObject({
      revisions: "1",
      rates: "64",
      receipts: "1",
      keys: "2",
      audits: "1",
    });
  });

  test("publishes and permanently replays the exact Unicode, range, BIGINT, and NUMERIC boundaries", async () => {
    const providerRef = fourByteText("publisher-provider", 255);
    const environment = fourByteText("publisher-environment", 255);
    const pricingAccountRef = fourByteText("publisher-account", 255);
    const modelRef = fourByteText("publisher-model", 255);
    const modelVersion = fourByteText("publisher-model-version", 255);
    const profileVersion = fourByteText("publisher-profile", 255);
    const dimension = "D".repeat(128);
    const applicabilityUnit = "U".repeat(128);
    const extreme = command({
      publicationIdentity: "publication-extreme",
      idempotencyKey: "publication-key-extreme",
      draft: {
        ...command().draft,
        profileRef: {
          version: profileVersion,
          artifactDigest: "a".repeat(64),
        },
        rates: [
          {
            providerRef,
            environment,
            pricingAccountRef,
            modelRef,
            modelVersion,
            bucket: "B".repeat(128),
            unit: "U".repeat(128),
            applicability: {
              kind: "range",
              dimension,
              unit: applicabilityUnit,
              lowerInclusive: MAX_BIGINT,
              upperExclusive: null,
            },
            currencyCode: "USD",
            minorPerUnit: {
              numerator: MAX_NUMERIC_78,
              denominator: COPRIME_NUMERIC_78,
            },
          },
        ],
      },
    });
    const published = await service.publishRate(context(), extreme);
    expect(await service.publishRate(context(), extreme)).toEqual(published);
    expect(
      await service.publishRate(context(), {
        ...extreme,
        idempotencyKey: "publication-key-extreme-replay",
      }),
    ).toEqual(published);
    const stored = await pool().query<{
      profile_version: string;
      provider_ref: string;
      environment: string;
      pricing_account_ref: string;
      model_ref: string;
      model_version: string;
      dimension: string;
      applicability_unit: string;
      lower_inclusive: string;
      upper_exclusive: string | null;
      numerator: string;
      denominator: string;
      binding_bytes: number;
    }>(
      `SELECT v.profile_version,r.provider_ref,r.environment,
               r.pricing_account_ref,r.model_ref,r.model_version,r.dimension,
               r.applicability_unit,r.lower_inclusive::text AS lower_inclusive,
               r.upper_exclusive::text AS upper_exclusive,
               r.minor_per_unit_numerator::text AS numerator,
               r.minor_per_unit_denominator::text AS denominator,
               octet_length(r.provider_ref)+octet_length(r.environment)+
               octet_length(r.pricing_account_ref)+octet_length(r.model_ref)+
               octet_length(r.model_version) AS binding_bytes
          FROM billing_metering_rate_revision v
          JOIN billing_metering_rate r
            ON r.tenant_id=v.tenant_id AND r.revision=v.revision
         WHERE v.tenant_id=$1 AND v.revision=1`,
      ["tenant-publication"],
    );
    expect(stored.rows).toEqual([
      {
        profile_version: profileVersion,
        provider_ref: providerRef,
        environment,
        pricing_account_ref: pricingAccountRef,
        model_ref: modelRef,
        model_version: modelVersion,
        dimension,
        applicability_unit: applicabilityUnit,
        lower_inclusive: MAX_BIGINT,
        upper_exclusive: null,
        numerator: MAX_NUMERIC_78,
        denominator: COPRIME_NUMERIC_78,
        binding_bytes: 5_100,
      },
    ]);
    expect(await counts()).toEqual({
      revisions: "1",
      rates: "1",
      receipts: "1",
      keys: "2",
      audits: "1",
    });
  });

  test("rejects every untrusted admin binding before durable effects", async () => {
    await assertDefined(application).close();
    application = undefined;
    for (const [admin, input] of [
      [null, command()],
      [{ ...context(), role: "other" }, command()],
      [context("other-tenant"), command()],
      [{ ...context(), operatorId: "other-operator" }, command()],
      [context(), command({ tenantId: "other-tenant" })],
      [
        context(),
        command({ draft: { ...command().draft, tenantId: "other-tenant" } }),
      ],
    ] as const)
      await expect(service.publishRate(admin, input)).rejects.toMatchObject({
        code: "METERING_PUBLICATION_FORBIDDEN",
      });
    expect(await counts()).toEqual({
      revisions: "0",
      rates: "0",
      receipts: "0",
      keys: "0",
      audits: "0",
    });
  });

  test("serializes concurrent identity replays without duplicating publication", async () => {
    const [first, second] = await Promise.all([
      service.publishRate(context(), command()),
      service.publishRate(
        context(),
        command({ idempotencyKey: "publication-key-concurrent" }),
      ),
    ]);
    expect(second).toEqual(first);
    expect(await counts()).toMatchObject({
      revisions: "1",
      rates: "1",
      receipts: "1",
      keys: "2",
      audits: "1",
    });
  });

  test("rejects command drift and rolls back exhausted generation", async () => {
    await service.publishRate(context(), command());
    await expect(
      service.publishRate(
        context(),
        command({
          idempotencyKey: "publication-key-drift",
          reason: "different reason",
        }),
      ),
    ).rejects.toMatchObject({ code: "METERING_PUBLICATION_CONFLICT" });

    await pool().query(
      `INSERT INTO billing_metering_rate_revision
       (id,tenant_id,revision,schema_version,effective_from,source_ref,verified_at,
        profile_version,profile_artifact_digest,content_digest,rate_count,published_at)
       VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,1,$10)`,
      [
        randomUUID(),
        "tenant-exhausted",
        MAX_BIGINT,
        "2026-10-04T12:00:00.000Z",
        "QA synthetic fixture",
        "2026-10-04T11:00:00.000Z",
        "usage-v1",
        "a".repeat(64),
        "b".repeat(64),
        "2026-10-04T12:30:00.000Z",
      ],
    );
    const exhausted = command({
      tenantId: "tenant-exhausted",
      publicationIdentity: "publication-exhausted",
      idempotencyKey: "publication-key-exhausted",
      draft: { ...command().draft, tenantId: "tenant-exhausted" },
    });
    await expect(
      service.publishRate(context("tenant-exhausted"), exhausted),
    ).rejects.toMatchObject({
      code: "METERING_PUBLICATION_REVISION_EXHAUSTED",
    });
    const effects = await counts();
    expect(effects).toMatchObject({
      receipts: "1",
      keys: "1",
      audits: "1",
    });
  });

  test("fails closed when durable ordinary rows drift before replay", async () => {
    await service.publishRate(context(), command());
    await pool().query(
      `UPDATE billing_metering_rate
          SET minor_per_unit_numerator=8
        WHERE tenant_id=$1 AND revision=1`,
      ["tenant-publication"],
    );
    await expect(
      service.publishRate(
        context(),
        command({ idempotencyKey: "publication-key-after-corruption" }),
      ),
    ).rejects.toMatchObject({ code: "METERING_PUBLICATION_CORRUPT" });
    expect(await counts()).toMatchObject({
      revisions: "1",
      rates: "1",
      receipts: "1",
      keys: "1",
      audits: "1",
    });
  });

  test.each(["result_json", "result_schema_version"] as const)(
    "rejects corrupt receipt %s under the original and a new key",
    async (field) => {
      await service.publishRate(context(), command());
      if (field === "result_json")
        await pool().query(
          `UPDATE billing_command_receipt
              SET result_json='{"schemaVersion":1}'::jsonb
            WHERE command_name='metering.publish_rate_revision'`,
        );
      else
        await pool().query(
          `UPDATE billing_command_receipt
              SET result_schema_version=2
            WHERE command_name='metering.publish_rate_revision'`,
        );
      await expect(
        service.publishRate(context(), command()),
      ).rejects.toMatchObject({ code: "METERING_PUBLICATION_CORRUPT" });
      await expect(
        service.publishRate(
          context(),
          command({ idempotencyKey: "publication-key-corrupt-replay" }),
        ),
      ).rejects.toMatchObject({ code: "METERING_PUBLICATION_CORRUPT" });
      expect(await counts()).toMatchObject({
        revisions: "1",
        rates: "1",
        receipts: "1",
        keys: "1",
        audits: "1",
      });
    },
  );

  test("rolls back every publication fact when the owned audit write fails", async () => {
    await pool().query(`
      CREATE FUNCTION fail_rate_publication_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned audit fault'; END $$;
      CREATE TRIGGER fail_rate_publication_audit
      BEFORE INSERT ON billing_audit_event
      FOR EACH ROW WHEN (NEW.action='metering.publish_rate_revision')
      EXECUTE FUNCTION fail_rate_publication_audit()`);
    await expect(
      service.publishRate(context(), command()),
    ).rejects.toMatchObject({ code: "METERING_PUBLICATION_UNAVAILABLE" });
    expect(await counts()).toEqual({
      revisions: "0",
      rates: "0",
      receipts: "0",
      keys: "0",
      audits: "0",
    });
  });
});
