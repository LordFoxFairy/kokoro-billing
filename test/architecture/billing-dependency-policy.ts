import type {
  DependencyDiagnostic,
  DependencyEdge,
  DependencyGraph,
} from "./typescript-dependency.types.js";

// B8 debt: fixed baseline, never learned from the graph under test. Removing debt
// is allowed; adding edges or changing these edges to runtime imports is not.
const legacyGroups = [
  [
    "checkout",
    "checkout",
    [
      "commands/checkout-service",
      "services/catalog-admin-service",
      "services/catalog-service",
    ],
  ],
  [
    "credit",
    "credit",
    [
      "services/admin-grant-service",
      "services/grant-expiry-service",
      "services/redeem-admin-service",
      "services/redeem-service",
      "services/subscription-grant-service",
    ],
  ],
  [
    "metering",
    "metering",
    [
      "services/billing-admission-service",
      "services/usage-pricing-admin-service",
      "services/usage-pricing-service",
      "services/usage-settlement-service",
    ],
  ],
  [
    "payment",
    "payment",
    [
      "commands/billing-settlement-service",
      "commands/provider-event-admin-service",
      "commands/provider-event-inbox-service",
    ],
  ],
  [
    "reconcile",
    "reconciliation",
    ["queries/admin-stats-service", "services/reconciliation-service"],
  ],
  ["refund", "refund", ["commands/billing-reversal-service"]],
  ["subscription", "subscription", ["queries/subscription-query-service"]],
] as const;
const edgeKey = (source: string, target: string) => `${source}\0${target}`;
const legacyTypeEdges = new Set<string>();
for (const [feature, repository, members] of legacyGroups) {
  const port = `src/application/${feature}/ports/${repository}-repository.ts`;
  for (const member of members) {
    const service = `src/application/${feature}/${member}.ts`;
    legacyTypeEdges.add(edgeKey(port, service));
    legacyTypeEdges.add(edgeKey(service, port));
  }
}
legacyTypeEdges.add(
  edgeKey(
    "src/application/checkout/services/catalog-admin-service.ts",
    "src/application/checkout/services/catalog-service.ts",
  ),
);

function feature(path: string): string | undefined {
  if (
    /^src\/application\/ports\/(?:transaction|idempotency-hint|safe-integer)\.ts$/.test(
      path,
    )
  )
    return undefined;
  return /^src\/(?:application|modules)\/([^/]+)\//.exec(path)?.[1];
}
const prisma = (edge: DependencyEdge) =>
  edge.target === "@prisma/client" ||
  edge.target.startsWith("@prisma/") ||
  edge.target.startsWith("src/generated/prisma/");
const database = (edge: DependencyEdge) =>
  prisma(edge) ||
  /^(?:pg|postgres|redis|ioredis)(?:\/|$)/.test(edge.target) ||
  /^src\/(?:infrastructure\/(?:postgres|redis)|database|cache)\//.test(
    edge.target,
  );
const persistence = (edge: DependencyEdge) =>
  database(edge) ||
  /(?:^|\/)[^/]*(?:[.-]repository|[.-]row)\.(?:ts|mts|cts|tsx)$/.test(
    edge.target,
  ) ||
  edge.symbols.some((symbol) =>
    /(?:Repository|PrismaClient|Pool|Redis)$/.test(symbol),
  );
const inCycle = (
  edge: DependencyEdge,
  groups: readonly (readonly string[])[],
) =>
  groups.some(
    (group) => group.includes(edge.source) && group.includes(edge.target),
  );

function exposesPersistence(
  graph: DependencyGraph,
  edge: DependencyEdge,
  visited = new Set<string>(),
): boolean {
  if (persistence(edge)) return true;
  if (edge.targetKind !== "internal") return false;
  for (const symbol of edge.symbols) {
    const key = edgeKey(edge.target, symbol);
    if (visited.has(key)) continue;
    visited.add(key);
    const available = graph.exports.filter(
      (binding) => binding.origin.source === edge.target,
    );
    const named = available.filter((binding) => binding.name === symbol);
    const matches =
      symbol === "*"
        ? available
        : named.length
          ? named
          : available.filter(
              (binding) => binding.name === "*" && symbol !== "default",
            );
    for (const binding of matches) {
      const origin =
        binding.name === "*" && symbol !== "*"
          ? { ...binding.origin, symbols: [symbol] }
          : binding.origin;
      if (
        persistence(origin) ||
        (!binding.terminal && exposesPersistence(graph, origin, visited))
      )
        return true;
    }
  }
  return false;
}

export function checkBillingDependencies(
  graph: DependencyGraph,
): readonly DependencyDiagnostic[] {
  const diagnostics = [...graph.diagnostics];
  for (const edge of graph.edges) {
    const report = (code: string) =>
      diagnostics.push({
        code,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        location: edge.location,
      });
    if (prisma(edge)) report("production-prisma");
    if (
      (edge.target === "node:module" || edge.target === "module") &&
      edge.symbols.some((symbol) =>
        ["*", "default", "createRequire"].includes(symbol),
      )
    )
      report("create-require");
    if (
      /^src\/(?:domain|application)\//.test(edge.source) &&
      /^src\/(?:infrastructure|interfaces)\//.test(edge.target)
    )
      report("layer-boundary");
    if (/^src\/application\//.test(edge.source) && database(edge))
      report("application-database");
    if (/^src\/interfaces\//.test(edge.source) && database(edge)) {
      const contextOnly =
        edge.source === "src/interfaces/http/server.ts" &&
        edge.target === "src/infrastructure/postgres/connection.ts" &&
        edge.form === "import" &&
        edge.kind === "value" &&
        edge.symbols.length === 1 &&
        edge.symbols[0] === "runWithBillingContext";
      if (!contextOnly) report("interfaces-database");
    }
    const sourceFeature = feature(edge.source);
    const targetFeature = feature(edge.target);
    if (
      sourceFeature &&
      targetFeature &&
      sourceFeature !== targetFeature &&
      !["ts", "mts", "cts", "tsx"].some((extension) =>
        ["application", "modules"].some(
          (root) =>
            edge.target ===
            `src/${root}/${targetFeature}/${targetFeature}.public.${extension}`,
        ),
      )
    )
      report("feature-private-import");
    if (/\.public\.(?:ts|mts|cts|tsx)$/.test(edge.source)) {
      if (edge.form === "export" && edge.symbols.includes("*"))
        report("public-wildcard");
      if (persistence(edge)) report("public-persistence");
    }
    if (
      /\.controller\.(?:ts|mts|cts|tsx)$/.test(edge.source) &&
      persistence(edge)
    )
      report("controller-persistence");
    if (
      /(?:\.|-)service\.(?:ts|mts|cts|tsx)$/.test(edge.source) &&
      /\.controller\.(?:ts|mts|cts|tsx)$/.test(edge.target)
    )
      report("service-controller");
    if (edge.kind === "value" && inCycle(edge, graph.cycles.value))
      report("value-cycle");
    const registered = legacyTypeEdges.has(edgeKey(edge.source, edge.target));
    if (
      (registered && edge.kind !== "type") ||
      (inCycle(edge, graph.cycles.all) && !(registered && edge.kind === "type"))
    )
      report("type-cycle-debt");
  }
  for (const binding of graph.exports) {
    const origin = binding.origin;
    if (
      /\.public\.(?:ts|mts|cts|tsx)$/.test(origin.source) &&
      (persistence(origin) ||
        (!binding.terminal && exposesPersistence(graph, origin))) &&
      !diagnostics.some(
        (item) =>
          item.code === "public-persistence" &&
          item.source === origin.source &&
          item.location.line === origin.location.line &&
          item.location.column === origin.location.column,
      )
    ) {
      diagnostics.push({
        code: "public-persistence",
        source: origin.source,
        target: origin.target,
        kind: origin.kind,
        location: origin.location,
      });
    }
  }
  return diagnostics.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.location.line - b.location.line ||
      a.location.column - b.location.column ||
      a.code.localeCompare(b.code),
  );
}
