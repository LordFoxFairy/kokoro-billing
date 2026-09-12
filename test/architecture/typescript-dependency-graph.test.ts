import { resolve } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readBillingDependencyGraph } from "./typescript-dependency-project.js";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeDependencies } from "./typescript-dependency-graph.js";
import { checkBillingDependencies } from "./billing-dependency-policy.js";

const root = "/fixtures/billing";
function graph(
  files: Record<string, string>,
  options: ts.CompilerOptions = {},
) {
  return analyzeDependencies({
    root,
    files: new Map(
      Object.entries(files).map(([path, source]) => [
        resolve(root, path),
        source,
      ]),
    ),
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      ...options,
    },
  });
}
const service = "src/modules/orders/orders.service.ts";
const repository = "src/modules/orders/orders.repository.ts";
const valid = {
  [service]: "import { Repository } from './orders.repository.js';",
  [repository]: "export class Repository {}",
};

function expectPolicy(files: Record<string, string>, code: string) {
  expect(checkBillingDependencies(graph(valid))).toEqual([]);
  expect(
    checkBillingDependencies(graph(files)).map((item) => item.code),
  ).toContain(code);
}

describe("TypeScript dependency syntax and resolver", () => {
  it.each([
    [
      "import { Repository as Local } from './orders.repository.js';",
      [["value", ["Repository"]]],
    ],
    [
      "import type { Repository } from './orders.repository.js';",
      [["type", ["Repository"]]],
    ],
    [
      "import { type Repository } from './orders.repository.js';",
      [["type", ["Repository"]]],
    ],
    [
      "import Default, { type Repository, value as local } from './orders.repository.js';",
      [
        ["type", ["Repository"]],
        ["value", ["default", "value"]],
      ],
    ],
    [
      "import * as repository from './orders.repository.js';",
      [["value", ["*"]]],
    ],
    ["import './orders.repository.js';", [["value", []]]],
    ["import {} from './orders.repository.js';", [["value", []]]],
    ["export {} from './orders.repository.js';", [["value", []]]],
    [
      "export type { Repository } from './orders.repository.js';",
      [["type", ["Repository"]]],
    ],
    [
      "export { type Repository, value as local } from './orders.repository.js';",
      [
        ["type", ["Repository"]],
        ["value", ["value"]],
      ],
    ],
    ["export * from './orders.repository.js';", [["value", ["*"]]]],
    [
      "export * as repository from './orders.repository.js';",
      [["value", ["*"]]],
    ],
    [
      "import repository = require('./orders.repository.js');",
      [["value", ["*"]]],
    ],
    [
      "import type repository = require('./orders.repository.js');",
      [["type", ["*"]]],
    ],
    [
      "type Repository = import('./orders.repository.js').Repository;",
      [["type", ["Repository"]]],
    ],
    [
      "type Repository = typeof import('./orders.repository.js');",
      [["type", ["*"]]],
    ],
    [
      "const repository = import('./orders.repository.js');",
      [["value", ["*"]]],
    ],
    [
      "const repository = require('./orders.repository.js');",
      [["value", ["*"]]],
    ],
  ] as const)(
    "classifies %s without guessing from text",
    (source, expected) => {
      const actual = graph({ ...valid, [service]: source });
      expect(actual.diagnostics).toEqual([]);
      expect(
        actual.edges.map((edge) => [edge.kind, edge.symbols]).sort(),
      ).toEqual([...expected].sort());
      expect(
        actual.edges.every(
          (edge) =>
            edge.target === repository &&
            edge.location.line === 1 &&
            edge.location.column > 0,
        ),
      ).toBe(true);
    },
  );

  it("ignores comments and ordinary strings and classifies external and builtin targets", () => {
    const actual = graph({
      [service]: `// import '@prisma/client';\nconst text = "infrastructure/pg @prisma/client";
      import { readFile } from 'node:fs'; import type { Pool } from 'pg';`,
    });
    expect(actual.edges.map((edge) => [edge.target, edge.targetKind])).toEqual([
      ["node:fs", "builtin"],
      ["pg", "external"],
    ]);
    expect(actual.diagnostics).toEqual([]);
  });

  it("resolves tsconfig aliases before deciding whether a specifier is external", () => {
    const options = {
      paths: { "@billing/*": ["./src/*"] },
      pathsBasePath: root,
    };
    const actual = graph(
      {
        ...valid,
        [service]:
          "import { Repository } from '@billing/modules/orders/orders.repository.js';",
      },
      options,
    );
    expect(actual.diagnostics).toEqual([]);
    expect(actual.edges[0]?.target).toBe(repository);
  });

  it.each([
    ["import './absent.js';", "unresolved-import"],
    ["import '/outside/owner.ts';", "path-escape"],
    ["import '../../../../outside.ts';", "path-escape"],
    ["const value = import(path);", "dynamic-loader"],
    ["require(path);", "dynamic-loader"],
    ["const = ;", "syntax-error"],
    ["const load = require; load('pg');", "loader-reference"],
    [
      "function f(require: (x: string) => void) { require('not-a-module'); }",
      "shadowed-require",
    ],
  ] as const)(
    "rejects unsupported or unresolved source: %s",
    (source, code) => {
      expect(graph(valid).diagnostics).toEqual([]);
      expect(
        graph({ [service]: source }).diagnostics.map((item) => item.code),
      ).toContain(code);
    },
  );

  it("rejects unresolved aliases rather than treating them as external packages", () => {
    expect(
      graph(
        { [service]: "import '@billing/missing.js';" },
        { paths: { "@billing/*": ["./src/*"] }, pathsBasePath: root },
      ).diagnostics.map((item) => item.code),
    ).toContain("unresolved-import");
  });
});

describe("Billing dependency policy", () => {
  it.each([
    "import { x }",
    "import type { x }",
    "import * as x",
    "export { x }",
    "export type { x }",
  ])("rejects infrastructure from application via %s", (statement) => {
    expectPolicy(
      {
        "src/application/orders/orders.service.ts": `${statement} from '../../infrastructure/postgres/database.js';`,
        "src/infrastructure/postgres/database.ts": "export const x = 1;",
      },
      "layer-boundary",
    );
  });

  it("rejects domain to interfaces and application to database packages", () => {
    expectPolicy(
      {
        "src/domain/order.ts": "import type { x } from '../interfaces/x.js';",
        "src/interfaces/x.ts": "export type x = string;",
      },
      "layer-boundary",
    );
    expectPolicy(
      { "src/application/order.ts": "import type { Pool } from 'pg';" },
      "application-database",
    );
  });

  it.each([
    "import { connection } from '../../infrastructure/postgres/connection.js';",
    "import * as connection from '../../infrastructure/postgres/connection.js';",
    "export { runWithBillingContext } from '../../infrastructure/postgres/connection.js';",
    "import { runWithBillingContext, connection } from '../../infrastructure/postgres/connection.js';",
    "const context = import('../../infrastructure/postgres/connection.js');",
  ])("keeps the HTTP context exception symbol-bounded: %s", (source) => {
    const files = {
      "src/interfaces/http/server.ts":
        "import { runWithBillingContext as scope } from '../../infrastructure/postgres/connection.js';",
      "src/infrastructure/postgres/connection.ts":
        "export const runWithBillingContext = 1; export const connection = 1;",
    };
    expect(checkBillingDependencies(graph(files))).toEqual([]);
    expectPolicy(
      { ...files, "src/interfaces/http/server.ts": source },
      "interfaces-database",
    );
  });

  it("requires explicit feature public entries but permits same-feature repositories", () => {
    expect(checkBillingDependencies(graph(valid))).toEqual([]);
    const publicFiles = {
      [service]: "import { Stock } from '../stock/stock.public.js';",
      "src/modules/stock/stock.public.ts":
        "export { Stock } from './stock.service.js';",
      "src/modules/stock/stock.service.ts": "export class Stock {}",
    };
    expect(checkBillingDependencies(graph(publicFiles))).toEqual([]);
    expectPolicy(
      {
        ...publicFiles,
        [service]: "import type { Stock } from '../stock/stock.service.js';",
      },
      "feature-private-import",
    );
    expectPolicy(
      {
        ...publicFiles,
        "src/modules/stock/stock.public.ts":
          "export * from './stock.service.js';",
      },
      "public-wildcard",
    );
    expectPolicy(
      {
        ...publicFiles,
        "src/modules/stock/stock.public.ts":
          "export { Stock } from './stock.repository.js';",
        "src/modules/stock/stock.repository.ts": "export class Stock {}",
      },
      "public-persistence",
    );
  });

  it("enforces controller and service direction without mandatory ports", () => {
    expectPolicy(
      {
        "src/modules/orders/orders.controller.ts":
          "import { Repository } from './orders.repository.js';",
        [repository]: valid[repository],
      },
      "controller-persistence",
    );
    expectPolicy(
      {
        [service]: "import { Controller } from './orders.controller.js';",
        "src/modules/orders/orders.controller.ts": "export class Controller {}",
      },
      "service-controller",
    );
  });

  it.each([
    "import { createRequire as load } from 'node:module';",
    "import * as modules from 'module'; const load = modules.createRequire(import.meta.url);",
    "const { createRequire: load } = require('node:module');",
  ])("rejects uncontrolled loader factories: %s", (source) => {
    expectPolicy({ [service]: source }, "create-require");
  });

  it.each([
    "import '@prisma/client';",
    "type Client = import('@prisma/client').PrismaClient;",
    "require('@prisma/client');",
    "import('../../generated/prisma/client.js');",
  ])("keeps production Prisma disabled: %s", (source) => {
    expectPolicy(
      {
        "src/modules/orders/service.ts": source,
        "src/generated/prisma/client.ts": "export class PrismaClient {}",
      },
      "production-prisma",
    );
  });

  it("allows only the transaction component's exact generated client imports", () => {
    const generated = "src/generated/prisma/client.ts";
    expect(
      checkBillingDependencies(
        graph({
          "src/database/transaction.service.ts":
            "import type { PrismaClient } from '../generated/prisma/client.js';",
          "src/database/transaction.types.ts":
            "import type { Prisma } from '../generated/prisma/client.js';",
          [generated]: "export class PrismaClient {}; export type Prisma = {};",
        }),
      ).filter((item) => item.code === "production-prisma"),
    ).toEqual([]);
    for (const [source, statement] of [
      [
        "src/database/bypass.ts",
        "import { PrismaClient } from '../generated/prisma/client.js';",
      ],
      [
        "src/database/transaction.error.ts",
        "import type { Prisma } from '../generated/prisma/client.js';",
      ],
      [
        "src/database/transaction.service.ts",
        "import type { Prisma } from '../generated/prisma/client.js';",
      ],
      [
        "src/database/transaction.types.ts",
        "import type { PrismaClient } from '../generated/prisma/client.js';",
      ],
      [
        "src/database/transaction.service.ts",
        "import { PrismaClient } from '@prisma/client';",
      ],
      [
        "src/database/transaction.types.ts",
        "import type { PrismaPg } from '@prisma/adapter-pg';",
      ],
    ] as const)
      expectPolicy(
        { [source]: statement, [generated]: "export class PrismaClient {}" },
        "production-prisma",
      );
  });

  it("reports value/type/all SCCs including self loops and mixed cycles", () => {
    const value = graph({
      "src/a.ts": "import './b.js';",
      "src/b.ts": "import './a.js';",
    });
    expect(value.cycles.value).toEqual([["src/a.ts", "src/b.ts"]]);
    expectPolicy({ "src/a.ts": "import './a.js';" }, "value-cycle");
    const mixed = {
      "src/a.ts": "import type { B } from './b.js'; export type A = string;",
      "src/b.ts": "import './a.js'; export type B = string;",
    };
    const actual = graph(mixed);
    expect(actual.cycles.value).toEqual([]);
    expect(actual.cycles.type).toEqual([]);
    expect(actual.cycles.all).toEqual([["src/a.ts", "src/b.ts"]]);
    expectPolicy(mixed, "type-cycle-debt");
  });

  it("allows only the fixed B8 type-debt edges, not expanded or value debt", () => {
    const port = "src/application/refund/ports/refund-repository.ts";
    const command =
      "src/application/refund/commands/billing-reversal-service.ts";
    const files = {
      [port]:
        "import type { Input } from '../commands/billing-reversal-service.js'; export interface Repository {}",
      [command]:
        "import type { Repository } from '../ports/refund-repository.js'; export interface Input {}",
    };
    expect(graph(files).cycles.type).toEqual([[command, port]]);
    expect(checkBillingDependencies(graph(files))).toEqual([]);
    expectPolicy(
      {
        ...files,
        [command]:
          "import { Repository } from '../ports/refund-repository.js'; export interface Input {}",
      },
      "type-cycle-debt",
    );
    expectPolicy(
      {
        ...files,
        [port]: `${files[port]} import type { Extra } from './extra.js';`,
        "src/application/refund/ports/extra.ts":
          "import type { Repository } from './refund-repository.js'; export interface Extra {}",
      },
      "type-cycle-debt",
    );
  });
});

describe("dependency graph closure and static loader boundaries", () => {
  it.each([
    "const repository = import(`./orders.repository.js`);",
    "const repository = require(`./orders.repository.js`);",
    "const repository = import('./orders.repository.js', { with: { type: 'json' } });",
    "export type * from './orders.repository.js';",
  ])("resolves static dependencies: %s", (source) => {
    const actual = graph({ ...valid, [service]: source });
    expect(actual.diagnostics).toEqual([]);
    expect(actual.edges[0]?.target).toBe(repository);
  });

  it("rejects an internal wrapper outside the analyzed file set with a stable diagnostic", () => {
    const path = resolve(root, service);
    const files = new Map([[path, "\nimport '../../../scripts/wrapper.js';"]]);
    const wrapper = resolve(root, "scripts/wrapper.ts");
    const actual = analyzeDependencies({
      root,
      files,
      options: { moduleResolution: ts.ModuleResolutionKind.NodeNext },
      host: {
        fileExists: (file) => file === wrapper || files.has(file),
        readFile: (file) => files.get(file),
      },
    });
    expect(actual.diagnostics).toEqual([
      {
        code: "unscanned-internal",
        source: service,
        target: "scripts/wrapper.ts",
        kind: "value",
        location: { line: 2, column: 1 },
      },
    ]);
  });

  it("rejects a symlink target outside the repository and preserves path casing", () => {
    const files = new Map(
      Object.entries(valid).map(([path, content]) => [
        resolve(root, path),
        content,
      ]),
    );
    const actual = analyzeDependencies({
      root,
      files,
      options: { moduleResolution: ts.ModuleResolutionKind.NodeNext },
      host: {
        fileExists: (file) => files.has(file),
        readFile: (file) => files.get(file),
        realpath: (file) =>
          file.endsWith("orders.repository.ts")
            ? "/outside/repository.ts"
            : file,
      },
    });
    expect(
      actual.diagnostics.some(
        (item) => item.code === "path-escape" && item.source === service,
      ),
    ).toBe(true);
    expect(
      graph({ ...valid, [service]: "import './Orders.repository.js';" })
        .diagnostics[0]?.code,
    ).toBe("unresolved-import");
  });

  it.each([
    "import(`pg/${name}`);",
    "require(`pg/${name}`);",
    "const load = require.bind(null);",
    "require.call(null, 'pg');",
  ])("rejects unsupported loader indirection: %s", (source) => {
    expect(graph(valid).diagnostics).toEqual([]);
    expect(graph({ [service]: source }).diagnostics.length).toBeGreaterThan(0);
  });

  it("does not give all shared ports or all interfaces the context exception", () => {
    expectPolicy(
      {
        [service]:
          "import type { X } from '../../application/ports/private.js';",
        "src/application/ports/private.ts": "export type X = string;",
      },
      "feature-private-import",
    );
    expectPolicy(
      {
        "src/interfaces/http/other.ts":
          "import { runWithBillingContext } from '../../infrastructure/postgres/connection.js';",
        "src/infrastructure/postgres/connection.ts":
          "export const runWithBillingContext = 1;",
      },
      "interfaces-database",
    );
  });
});

describe("real project input uses the same closed graph", () => {
  it("scans every supported TS extension and only exempts the exact Prisma output", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "billing-dependency-"));
    try {
      await mkdir(resolve(directory, "src/generated/prisma"), {
        recursive: true,
      });
      await mkdir(resolve(directory, "src/modules/generated"), {
        recursive: true,
      });
      await writeFile(
        resolve(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            paths: { "@local/*": ["./src/*"] },
          },
          include: ["src"],
        }),
      );
      for (const extension of ["ts", "mts", "cts", "tsx"])
        await writeFile(
          resolve(directory, `src/source.${extension}`),
          "import '@prisma/client';",
        );
      await writeFile(
        resolve(directory, "src/modules/generated/local.ts"),
        "import '@prisma/client';",
      );
      await writeFile(
        resolve(directory, "src/generated/prisma/client.ts"),
        "const = ;",
      );
      await writeFile(
        resolve(directory, "src/alias.ts"),
        "import '@local/source.js';",
      );
      const actual = await readBillingDependencyGraph(directory);
      expect(actual.diagnostics).toEqual([]);
      expect(actual.nodes).toEqual([
        "src/alias.ts",
        "src/modules/generated/local.ts",
        "src/source.cts",
        "src/source.mts",
        "src/source.ts",
        "src/source.tsx",
      ]);
      expect(
        actual.edges.find((edge) => edge.source === "src/alias.ts")?.target,
      ).toBe("src/source.ts");
      expect(
        checkBillingDependencies(actual).filter(
          (item) => item.code === "production-prisma",
        ),
      ).toHaveLength(5);
      await writeFile(
        resolve(directory, "src/local.js"),
        "require('@prisma/client');",
      );
      await writeFile(
        resolve(directory, "src/alias.ts"),
        "import './local.js';",
      );
      const withWrapper = await readBillingDependencyGraph(directory);
      expect(withWrapper.diagnostics).toContainEqual({
        code: "unscanned-internal",
        source: "src/alias.ts",
        target: "src/local.js",
        kind: "value",
        location: { line: 1, column: 1 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("repository path identity", () => {
  it("rejects file URL module paths instead of misclassifying them as packages", () => {
    expect(graph(valid).diagnostics).toEqual([]);
    const actual = graph({ [service]: "import 'file:///outside/wrapper.js';" });
    expect(actual.diagnostics).toContainEqual({
      code: "unsupported-module-url",
      source: service,
      target: "file:///outside/wrapper.js",
      kind: "value",
      location: { line: 1, column: 1 },
    });
  });
});

describe("target database boundaries across supported TS extensions", () => {
  it.each(["ts", "mts", "cts", "tsx"])(
    "keeps controller/service/public/repository policy active for .%s",
    (extension) => {
      const suffix =
        extension === "mts" ? "mjs" : extension === "cts" ? "cjs" : "js";
      const controller = `src/modules/orders/orders.controller.${extension}`;
      const localService = `src/modules/orders/orders.service.${extension}`;
      const localRepository = `src/modules/orders/orders.repository.${extension}`;
      const fixtures = {
        [localService]: `import { Repository } from './orders.repository.${suffix}';`,
        [localRepository]: "export class Repository {}",
      };
      expect(checkBillingDependencies(graph(fixtures))).toEqual([]);
      expectPolicy(
        {
          ...fixtures,
          [controller]: `import { Repository } from './orders.repository.${suffix}';`,
        },
        "controller-persistence",
      );
      expectPolicy(
        {
          [localService]: `import { Controller } from './orders.controller.${suffix}';`,
          [controller]: "export class Controller {}",
        },
        "service-controller",
      );
      const entry = `src/modules/orders/orders.public.${extension}`;
      expectPolicy(
        { ...fixtures, [entry]: `export * from './orders.service.${suffix}';` },
        "public-wildcard",
      );
      expectPolicy(
        {
          ...fixtures,
          [entry]: `export { Repository as Store } from './orders.repository.${suffix}';`,
        },
        "public-persistence",
      );
      expect(
        checkBillingDependencies(
          graph({
            ...fixtures,
            [localService]: `${fixtures[localService]} export class Api {}`,
            [entry]: `export { Api } from './orders.service.${suffix}';`,
            [`src/modules/stock/stock.service.${extension}`]: `import { Api } from '../orders/orders.public.${suffix}';`,
          }),
        ),
      ).toEqual([]);
    },
  );

  it.each(["database/database.service", "cache/redis.service"])(
    "rejects controller imports from the target %s root",
    (target) => {
      expectPolicy(
        {
          "src/modules/orders/orders.controller.ts": `import { DatabaseService } from '../../${target}.js';`,
          [`src/${target}.ts`]: "export class DatabaseService {}",
        },
        "controller-persistence",
      );
    },
  );
});

describe("public named export lineage", () => {
  const repo = "src/modules/orders/orders.repository.ts";
  const bridge = "src/modules/orders/bridge.ts";
  const entry = "src/modules/orders/orders.public.ts";
  const servicePath = "src/modules/orders/orders.service.ts";
  const baseline = {
    [repo]: "export class OrdersRepository {}",
    [servicePath]:
      "import { OrdersRepository } from './orders.repository.js'; export class OrdersService { store = new OrdersRepository(); }",
    [bridge]:
      "export { OrdersRepository as Store } from './orders.repository.js'; export { OrdersService as Api } from './orders.service.js';",
    [entry]: "export { Api } from './bridge.js';",
    "src/modules/payment/payment.service.ts":
      "import { Api } from '../orders/orders.public.js';",
  };
  it.each([
    ["export { Store } from './bridge.js';", baseline[bridge]],
    [
      "export type { Store } from './bridge.js';",
      "export type { OrdersRepository as Store } from './orders.repository.js';",
    ],
    [
      "import { Store as Local } from './bridge.js'; export { Local as Api };",
      baseline[bridge],
    ],
    [
      "export { Store } from './bridge.js';",
      "import type { OrdersRepository as Local } from './orders.repository.js'; export type { Local as Store };",
    ],
    [
      "export { Store } from './bridge.js';",
      "export * as Store from './orders.repository.js';",
    ],
    ["export { Store } from './bridge.js';", "export * from './second.js';"],
    [
      "export { Store } from './bridge.js';",
      "import * as Local from './orders.repository.js'; export { Local as Store };",
    ],
    [
      "export { default as Store } from './bridge.js';",
      "import { OrdersRepository as Local } from './orders.repository.js'; export default Local;",
    ],
  ])("rejects persistence lineage: %s / %s", (publicSource, bridgeSource) => {
    expect(checkBillingDependencies(graph(baseline))).toEqual([]);
    const actual = graph({
      ...baseline,
      [entry]: publicSource,
      [bridge]: bridgeSource,
      "src/modules/orders/second.ts":
        "export { OrdersRepository as Store } from './orders.repository.js';",
    });
    expect(actual.diagnostics).toEqual([]);
    expect(checkBillingDependencies(actual)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "public-persistence", source: entry }),
      ]),
    );
  });

  it("keeps explicit safe exports separate from wildcard siblings and local import aliases", () => {
    expect(checkBillingDependencies(graph(baseline))).toEqual([]);
    const actual = graph({
      ...baseline,
      [bridge]:
        "export * from './orders.repository.js'; export { OrdersService as Api } from './orders.service.js';",
      [entry]:
        "import { Api as Local } from './bridge.js'; export { Local as Api };",
    });
    expect(actual.diagnostics).toEqual([]);
    expect(checkBillingDependencies(actual)).toEqual([]);
  });

  it("tracks only the selected symbol, not every export/import reachable from the module", () => {
    const actual = graph(baseline);
    expect(actual.diagnostics).toEqual([]);
    expect(checkBillingDependencies(actual)).toEqual([]);
  });
});
