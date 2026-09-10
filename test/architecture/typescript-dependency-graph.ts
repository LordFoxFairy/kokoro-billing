import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type {
  DependencyDiagnostic,
  DependencyEdge,
  DependencyExport,
  DependencyForm,
  DependencyGraph,
  DependencyKind,
  DependencyProject,
} from "./typescript-dependency.types.js";

const slash = (path: string) => path.split(sep).join("/");
const outside = (root: string, path: string) => {
  const value = relative(root, path);
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
};

function memoryHost(project: DependencyProject): ts.ModuleResolutionHost {
  return {
    fileExists: (path) => project.files.has(resolve(path)),
    readFile: (path) => project.files.get(resolve(path)),
    directoryExists: (path) =>
      [...project.files.keys()].some((file) =>
        file.startsWith(`${resolve(path)}${sep}`),
      ),
    getCurrentDirectory: () => project.root,
    realpath: (path) => resolve(path),
  };
}

function cycles(
  nodes: readonly string[],
  edges: readonly DependencyEdge[],
  kind: DependencyKind | "all",
): readonly (readonly string[])[] {
  const adjacency = new Map(nodes.map((node) => [node, new Set<string>()]));
  for (const edge of edges) {
    if (
      edge.targetKind === "internal" &&
      (kind === "all" || edge.kind === kind) &&
      adjacency.has(edge.target)
    )
      adjacency.get(edge.source)?.add(edge.target);
  }
  // Kosaraju keeps graph traversal separate from Billing's temporary debt policy.
  const visited = new Set<string>();
  const order: string[] = [];
  function visit(node: string) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const target of adjacency.get(node) ?? []) visit(target);
    order.push(node);
  }
  for (const node of nodes) visit(node);
  const reverse = new Map(nodes.map((node) => [node, new Set<string>()]));
  for (const [source, targets] of adjacency)
    for (const target of targets) reverse.get(target)?.add(source);
  visited.clear();
  const result: string[][] = [];
  function collect(node: string, group: string[]) {
    if (visited.has(node)) return;
    visited.add(node);
    group.push(node);
    for (const target of reverse.get(node) ?? []) collect(target, group);
  }
  for (const node of order.reverse()) {
    if (visited.has(node)) continue;
    const group: string[] = [];
    collect(node, group);
    if (group.length > 1 || adjacency.get(node)?.has(node))
      result.push(group.sort());
  }
  return result.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

// Follow only static module bindings: never class bodies or arbitrary JS values.
function moduleExports(
  file: ts.SourceFile,
  source: string,
  edges: readonly DependencyEdge[],
): DependencyExport[] {
  const result: DependencyExport[] = [];
  const imports = new Map<string, DependencyEdge>();
  const point = (node: ts.Node) => {
    const value = file.getLineAndCharacterOfPosition(node.getStart(file));
    return { line: value.line + 1, column: value.character + 1 };
  };
  const dependency = (node: ts.Node, kind: DependencyKind) => {
    const location = point(node);
    return edges.find(
      (edge) =>
        edge.source === source &&
        edge.kind === kind &&
        edge.location.line === location.line &&
        edge.location.column === location.column,
    );
  };
  const remember = (
    local: string,
    imported: string,
    node: ts.Node,
    kind: DependencyKind,
  ) => {
    const edge = dependency(node, kind);
    if (edge) imports.set(local, { ...edge, symbols: [imported] });
  };
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      const kind = clause.isTypeOnly ? "type" : "value";
      if (clause.name) remember(clause.name.text, "default", node, kind);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named))
        remember(named.name.text, "*", node, kind);
      if (named && ts.isNamedImports(named))
        for (const item of named.elements)
          remember(
            item.name.text,
            (item.propertyName ?? item.name).text,
            node,
            clause.isTypeOnly || item.isTypeOnly ? "type" : "value",
          );
    } else if (ts.isImportEqualsDeclaration(node))
      remember(node.name.text, "*", node, node.isTypeOnly ? "type" : "value");
  }
  const local = (
    name: string,
    symbol: string,
    node: ts.Node,
    kind: DependencyKind,
  ) => {
    const imported = imports.get(symbol);
    result.push({
      name,
      terminal: !imported,
      origin: imported
        ? { ...imported, form: "export", kind, location: point(node) }
        : {
            source,
            target: source,
            targetKind: "internal",
            specifier: "",
            symbols: [symbol],
            form: "export",
            kind,
            location: point(node),
          },
    });
  };
  const forwarded = (
    name: string,
    symbol: string,
    node: ts.Node,
    kind: DependencyKind,
  ) => {
    const edge = dependency(node, kind);
    if (edge)
      result.push({
        name,
        terminal: false,
        origin: { ...edge, symbols: [symbol] },
      });
  };
  for (const node of file.statements) {
    if (ts.isExportDeclaration(node)) {
      const kind = node.isTypeOnly ? "type" : "value";
      const clause = node.exportClause;
      if (!clause) forwarded("*", "*", node, kind);
      else if (ts.isNamespaceExport(clause))
        forwarded(clause.name.text, "*", node, kind);
      else
        for (const item of clause.elements) {
          const symbol = (item.propertyName ?? item.name).text;
          const itemKind =
            node.isTypeOnly || item.isTypeOnly ? "type" : "value";
          if (node.moduleSpecifier)
            forwarded(item.name.text, symbol, node, itemKind);
          else local(item.name.text, symbol, node, itemKind);
        }
    } else if (
      ts.isExportAssignment(node) &&
      ts.isIdentifier(node.expression)
    ) {
      local("default", node.expression.text, node, "value");
    } else if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node) ?? [];
      if (
        !modifiers.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      )
        continue;
      const isDefault = modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );
      if (
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)
      ) {
        const name = node.name?.text ?? "default";
        local(
          isDefault ? "default" : name,
          name,
          node,
          ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
            ? "type"
            : "value",
        );
      } else if (ts.isVariableStatement(node)) {
        const names = (name: ts.BindingName): void => {
          if (ts.isIdentifier(name)) local(name.text, name.text, node, "value");
          else
            for (const element of name.elements)
              if (ts.isBindingElement(element)) names(element.name);
        };
        for (const declaration of node.declarationList.declarations)
          names(declaration.name);
      }
    }
  }
  return result;
}

export function analyzeDependencies(
  project: DependencyProject,
): DependencyGraph {
  const root = resolve(project.root);
  const host = project.host ?? memoryHost(project);
  const edges: DependencyEdge[] = [];
  const diagnostics: DependencyDiagnostic[] = [];
  const sources = new Map(
    [...project.files].map(([path, content]) => [
      resolve(path),
      ts.createSourceFile(resolve(path), content, ts.ScriptTarget.Latest, true),
    ]),
  );
  const compilerHost: ts.CompilerHost = {
    ...ts.createCompilerHost(project.options),
    fileExists: (path) => host.fileExists(path),
    readFile: (path) => host.readFile(path),
    getSourceFile: (path) => sources.get(resolve(path)),
  };
  const program = ts.createProgram(
    [...sources.keys()],
    { ...project.options, noResolve: true, noLib: true },
    compilerHost,
  );
  const nodes = [...sources.keys()]
    .map((path) => slash(relative(root, path)))
    .sort();
  for (const [path, sourceFile] of sources) {
    const source = slash(relative(root, path));
    const location = (node: ts.Node) => {
      const point = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      return { line: point.line + 1, column: point.character + 1 };
    };
    const report = (
      code: string,
      node: ts.Node,
      target = "",
      kind: DependencyKind | "unknown" = "unknown",
    ) =>
      diagnostics.push({
        code,
        source,
        target,
        kind,
        location: location(node),
      });
    if (outside(root, path) || outside(root, host.realpath?.(path) ?? path)) {
      report("path-escape", sourceFile, path);
      continue;
    }
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      const point = sourceFile.getLineAndCharacterOfPosition(
        diagnostic.start ?? 0,
      );
      diagnostics.push({
        code: "syntax-error",
        source,
        target: `TS${diagnostic.code}`,
        kind: "unknown",
        location: { line: point.line + 1, column: point.character + 1 },
      });
    }
    const add = (
      specifier: string,
      node: ts.Node,
      kind: DependencyKind,
      form: DependencyForm,
      symbols: string[],
    ) => {
      let target = specifier;
      let targetKind: DependencyEdge["targetKind"] = isBuiltin(specifier)
        ? "builtin"
        : "external";
      if (targetKind !== "builtin") {
        if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
          report("unsupported-module-url", node, specifier, kind);
          return;
        }

        const relativeImport =
          specifier.startsWith(".") || isAbsolute(specifier);
        if (
          relativeImport &&
          outside(root, resolve(dirname(path), specifier))
        ) {
          report("path-escape", node, specifier, kind);
          return;
        }
        const resolved = ts.resolveModuleName(
          specifier,
          path,
          project.options,
          host,
        ).resolvedModule;
        const alias = Object.keys(project.options.paths ?? {}).some(
          (pattern) => {
            const star = pattern.indexOf("*");
            return star === -1
              ? pattern === specifier
              : specifier.startsWith(pattern.slice(0, star)) &&
                  specifier.endsWith(pattern.slice(star + 1));
          },
        );
        if (
          resolved &&
          !resolved.isExternalLibraryImport &&
          !resolved.resolvedFileName.includes("/node_modules/")
        ) {
          const canonical =
            host.realpath?.(resolved.resolvedFileName) ??
            resolved.resolvedFileName;
          if (outside(root, canonical)) {
            report("path-escape", node, canonical, kind);
            return;
          }
          target = slash(relative(root, canonical));
          targetKind = "internal";
          if (
            !sources.has(resolve(canonical)) &&
            !target.startsWith("src/generated/prisma/")
          ) {
            report("unscanned-internal", node, target, kind);
            return;
          }
          if (slash(relative(root, resolved.resolvedFileName)) !== target) {
            report("noncanonical-import", node, target, kind);
            return;
          }
        } else if (relativeImport || alias || specifier.startsWith("#")) {
          report("unresolved-import", node, specifier, kind);
          return;
        }
      }
      edges.push({
        source,
        target,
        specifier,
        targetKind,
        kind,
        form,
        symbols: symbols.sort(),
        location: location(node),
      });
    };
    // `require` is reserved in production source. Shadowing/aliasing is deliberately
    // rejected, not incorrectly resolved as a Node dependency or silently ignored.
    let shadowed = false;
    function bindings(node: ts.Node) {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isBindingElement(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isImportClause(node) ||
          ts.isImportSpecifier(node) ||
          ts.isNamespaceImport(node) ||
          ts.isImportEqualsDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === "require"
      ) {
        shadowed = true;
        report("shadowed-require", node);
      }
      ts.forEachChild(node, bindings);
    }
    bindings(sourceFile);
    function walk(node: ts.Node) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const clause = node.importClause;
        const values: string[] = [];
        const types: string[] = [];
        const bucket = clause?.isTypeOnly ? types : values;
        if (clause?.name) bucket.push("default");
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) bucket.push("*");
        if (named && ts.isNamedImports(named))
          for (const item of named.elements)
            (clause?.isTypeOnly || item.isTypeOnly ? types : values).push(
              (item.propertyName ?? item.name).text,
            );
        if (types.length)
          add(node.moduleSpecifier.text, node, "type", "import", types);
        if (values.length || !types.length)
          add(
            node.moduleSpecifier.text,
            node,
            clause?.isTypeOnly ? "type" : "value",
            "import",
            values,
          );
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const values: string[] = [];
        const types: string[] = [];
        if (!node.exportClause || ts.isNamespaceExport(node.exportClause))
          (node.isTypeOnly ? types : values).push("*");
        else
          for (const item of node.exportClause.elements)
            (node.isTypeOnly || item.isTypeOnly ? types : values).push(
              (item.propertyName ?? item.name).text,
            );
        if (types.length)
          add(node.moduleSpecifier.text, node, "type", "export", types);
        if (values.length || !types.length)
          add(
            node.moduleSpecifier.text,
            node,
            node.isTypeOnly ? "type" : "value",
            "export",
            values,
          );
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const expression = node.moduleReference.expression;
        if (expression && ts.isStringLiteral(expression))
          add(
            expression.text,
            node,
            node.isTypeOnly ? "type" : "value",
            "import-equals",
            ["*"],
          );
        else report("dynamic-loader", node);
      } else if (ts.isImportTypeNode(node)) {
        if (
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        )
          add(node.argument.literal.text, node, "type", "import-type", [
            node.qualifier?.getText(sourceFile) ?? "*",
          ]);
        else report("dynamic-loader", node);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            !shadowed))
      ) {
        const argument = node.arguments[0];
        if (
          argument &&
          (ts.isStringLiteral(argument) ||
            ts.isNoSubstitutionTemplateLiteral(argument)) &&
          (node.arguments.length === 1 ||
            (node.expression.kind === ts.SyntaxKind.ImportKeyword &&
              node.arguments.length === 2))
        )
          add(
            argument.text,
            node,
            "value",
            node.expression.kind === ts.SyntaxKind.ImportKeyword
              ? "dynamic-import"
              : "require",
            ["*"],
          );
        else report("dynamic-loader", node);
      } else if (
        ts.isIdentifier(node) &&
        node.text === "require" &&
        !shadowed &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        report("loader-reference", node);
      }
      ts.forEachChild(node, walk);
    }
    walk(sourceFile);
  }
  const key = (item: DependencyDiagnostic | DependencyEdge) =>
    `${item.source}\0${String(item.location.line).padStart(8, "0")}\0${String(item.location.column).padStart(8, "0")}\0${item.kind}\0${item.target}`;
  edges.sort((a, b) => key(a).localeCompare(key(b)));
  diagnostics.sort(
    (a, b) => key(a).localeCompare(key(b)) || a.code.localeCompare(b.code),
  );
  return {
    nodes,
    exports: [...sources].flatMap(([path, file]) =>
      moduleExports(file, slash(relative(root, path)), edges),
    ),
    edges,
    diagnostics,
    cycles: {
      value: cycles(nodes, edges, "value"),
      type: cycles(nodes, edges, "type"),
      all: cycles(nodes, edges, "all"),
    },
  };
}
