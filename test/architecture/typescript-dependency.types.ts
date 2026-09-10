import type ts from "typescript";

export type DependencyKind = "type" | "value";
export type DependencyForm =
  | "import"
  | "export"
  | "import-equals"
  | "import-type"
  | "dynamic-import"
  | "require";
export type DependencyLocation = {
  readonly line: number;
  readonly column: number;
};
export type DependencyEdge = {
  readonly source: string;
  readonly target: string;
  readonly specifier: string;
  readonly targetKind: "internal" | "external" | "builtin";
  readonly kind: DependencyKind;
  readonly form: DependencyForm;
  readonly symbols: readonly string[];
  readonly location: DependencyLocation;
};
export type DependencyDiagnostic = {
  readonly code: string;
  readonly source: string;
  readonly target: string;
  readonly kind: DependencyKind | "unknown";
  readonly location: DependencyLocation;
};
export type DependencyExport = {
  readonly name: string;
  readonly origin: DependencyEdge;
  readonly terminal: boolean;
};
export type DependencyGraph = {
  readonly exports: readonly DependencyExport[];
  readonly nodes: readonly string[];
  readonly edges: readonly DependencyEdge[];
  readonly diagnostics: readonly DependencyDiagnostic[];
  readonly cycles: Readonly<
    Record<DependencyKind | "all", readonly (readonly string[])[]>
  >;
};
export type DependencyProject = {
  readonly root: string;
  readonly files: ReadonlyMap<string, string>;
  readonly options: ts.CompilerOptions;
  readonly host?: ts.ModuleResolutionHost;
};
