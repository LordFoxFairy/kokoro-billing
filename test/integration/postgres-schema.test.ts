import { assertDefined } from "../assert-defined.js";
import { describe, expect, it } from "vitest";
import { createBillingConnection } from "../../src/infrastructure/postgres/connection.js";
import type { RowDataPacket } from "../../src/infrastructure/postgres/connection.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("billing canonical PostgreSQL schema", () => {
  it("contains only owner-prefixed Billing tables and no schema history table", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    try {
      const [tables] = await connection.query<
        (RowDataPacket & { table_name: string })[]
      >(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      );
      const names = tables.map((row) => row.table_name);
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((name) => name.startsWith("billing_"))).toBe(true);
      expect(names.some((name) => name.includes("billing_entitlement"))).toBe(
        false,
      );
      expect(names).not.toContain("billing_schema_migrations");
      expect(names).toContain("billing_command_receipt");
    } finally {
      await connection.end();
    }
  });

  it("uses application-owned cross-table integrity and UTC millisecond timestamps", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    try {
      const [relations] = await connection.query<
        (RowDataPacket & { constraint_type: string })[]
      >(
        `SELECT constraint_type
           FROM information_schema.table_constraints
          WHERE constraint_schema = current_schema() AND constraint_type IN ('FOREIGN KEY', 'REFERENTIAL ACTION')`,
      );
      expect(relations).toEqual([]);

      const [timestamps] = await connection.query<
        (RowDataPacket & {
          table_name: string;
          column_name: string;
          data_type: string;
          datetime_precision: number;
        })[]
      >(
        `SELECT table_name, column_name, data_type, datetime_precision
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND data_type IN ('timestamp without time zone', 'timestamp with time zone')
          ORDER BY table_name, column_name`,
      );
      expect(timestamps.length).toBeGreaterThan(0);
      expect(
        timestamps.every(
          (row) =>
            row.data_type === "timestamp with time zone" &&
            row.datetime_precision === 3,
        ),
      ).toBe(true);

      const [moneyColumns] = await connection.query<
        (RowDataPacket & {
          table_name: string;
          column_name: string;
          data_type: string;
        })[]
      >(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND (column_name LIKE '%amount%' OR column_name LIKE '%micros%')
          ORDER BY table_name, column_name`,
      );
      expect(moneyColumns.length).toBeGreaterThan(0);
      expect(moneyColumns.every((row) => row.data_type === "bigint")).toBe(
        true,
      );
    } finally {
      await connection.end();
    }
  });

  it("installs the deliberate dispatch and tenant query indexes", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    try {
      const [indexes] = await connection.query<
        (RowDataPacket & { index_name: string })[]
      >(
        `SELECT indexname AS index_name
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN ($1, $2, $3, $4, $5)
          ORDER BY indexname`,
        [
          "ix_billing_outbox_dispatch",
          "ix_billing_provider_event_processing",
          "ix_billing_settlement_checkout",
          "ix_billing_credit_hold_expiry",
          "ix_billing_credit_grant_expiry",
        ],
      );
      expect(indexes.map((row) => row.index_name)).toEqual([
        "ix_billing_credit_grant_expiry",
        "ix_billing_credit_hold_expiry",
        "ix_billing_outbox_dispatch",
        "ix_billing_provider_event_processing",
        "ix_billing_settlement_checkout",
      ]);
    } finally {
      await connection.end();
    }
  });

  it("does not persist an unverified signature claim for trusted internal execution events", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    try {
      const [columns] = await connection.query<
        (RowDataPacket & { column_name: string })[]
      >(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'billing_execution_event'
          ORDER BY ordinal_position`,
      );
      expect(columns.map((row) => row.column_name)).not.toContain("signature");
    } finally {
      await connection.end();
    }
  });

  it("uses command identity without a durable receipt lease in the single-transaction claim model", async () => {
    const connection = await createBillingConnection(
      assertDefined(databaseUrl),
    );
    try {
      const [columns] = await connection.query<
        (RowDataPacket & { table_name: string; column_name: string })[]
      >(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'billing_command_receipt'
          ORDER BY table_name, ordinal_position`,
      );
      const receiptColumns = new Map<string, string[]>();
      for (const row of columns) {
        const names = receiptColumns.get(row.table_name) ?? [];
        names.push(row.column_name);
        receiptColumns.set(row.table_name, names);
      }
      expect(receiptColumns.get("billing_command_receipt")).toContain(
        "command_identity",
      );
      expect(receiptColumns.get("billing_command_receipt")).not.toContain(
        "lease_until",
      );

      const [indexes] = await connection.query<
        (RowDataPacket & { index_name: string })[]
      >(
        `SELECT indexname AS index_name
           FROM pg_indexes
          WHERE schemaname = current_schema() AND indexname = $1`,
        ["uq_billing_command_receipt_identity"],
      );
      expect(indexes).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });
});
