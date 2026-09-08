import { describe, expect, it } from "vitest";
import { compareSchemaCatalogs } from "../../scripts/schema-verification.js";
import type { SchemaCatalog } from "../../scripts/schema-catalog.types.js";

const empty = (): SchemaCatalog => ({
  serverVersion: "180004",
  database: [],
  relations: [],
  columns: [],
  constraints: [],
  indexes: [],
  types: [],
  routines: [],
  triggers: [],
  rules: [],
  policies: [],
});

describe("schema catalog comparison", () => {
  it("sorts missing, unexpected, and changed differences without normalizing definitions", () => {
    const expected = {
      ...empty(),
      columns: [
        { key: "public.a.1", definition: "text|DEFAULT 'A  B'" },
        { key: "public.z.1", definition: "bigint" },
      ],
    };
    const actual = {
      ...empty(),
      columns: [
        { key: "public.a.1", definition: "text|DEFAULT 'a b'" },
        { key: "public.b.1", definition: "text" },
      ],
    };
    expect(compareSchemaCatalogs(expected, actual)).toEqual([
      {
        category: "columns",
        key: "public.a.1",
        kind: "changed",
        expected: "text|DEFAULT 'A  B'",
        actual: "text|DEFAULT 'a b'",
      },
      {
        category: "columns",
        key: "public.b.1",
        kind: "unexpected",
        actual: "text",
      },
      {
        category: "columns",
        key: "public.z.1",
        kind: "missing",
        expected: "bigint",
      },
    ]);
  });
});
