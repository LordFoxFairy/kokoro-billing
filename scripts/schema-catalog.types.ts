export type CatalogItem = { readonly key: string; readonly definition: string };
export type SchemaCatalog = {
  readonly serverVersion: string;
  readonly database: readonly CatalogItem[];
  readonly relations: readonly CatalogItem[];
  readonly columns: readonly CatalogItem[];
  readonly constraints: readonly CatalogItem[];
  readonly indexes: readonly CatalogItem[];
  readonly types: readonly CatalogItem[];
  readonly routines: readonly CatalogItem[];
  readonly triggers: readonly CatalogItem[];
  readonly rules: readonly CatalogItem[];
  readonly policies: readonly CatalogItem[];
};

export type CatalogDifference = {
  readonly category: keyof Omit<SchemaCatalog, "serverVersion">;
  readonly key: string;
  readonly kind: "missing" | "unexpected" | "changed";
  readonly expected?: string;
  readonly actual?: string;
};

export type SchemaVerificationResult = {
  readonly canonicalSha256: string;
  readonly serverVersion: string;
  readonly objectCounts: Readonly<
    Record<keyof Omit<SchemaCatalog, "serverVersion">, number>
  >;
  readonly differences: readonly CatalogDifference[];
};
