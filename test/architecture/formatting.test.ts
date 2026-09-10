import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { check, format, getFileInfo, resolveConfig, version } from "prettier";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import ts from "typescript";

const sourceGlob =
  "{src,test,scripts}/**/*.{ts,mts,cts,tsx,js,mjs,cjs,json,yaml,yml}";
const rootGlob = "*.{ts,mts,cts,tsx,mjs,json,yaml,yml}";
const githubGlob = ".github/**/*.{ts,mts,cts,tsx,js,mjs,cjs,json,yaml,yml}";
const invocation =
  "prettier --config .prettierrc.json --ignore-path .prettierignore --no-editorconfig";
const targets = `"${sourceGlob}" "${rootGlob}" "${githubGlob}" ".prettierrc.json"`;
const ignored = [
  "/src/generated/prisma/",
  "/database/generated/",
  "/node_modules/",
  "/dist/",
  "/coverage/",
  "/pnpm-lock.yaml",
];

const manifestSchema = z.object({
  devDependencies: z.object({ prettier: z.literal("3.9.6") }),
  scripts: z.object({
    format: z.string(),
    "format:check": z.string(),
    verify: z.string(),
  }),
});

describe("repository formatting governance", () => {
  it("pins the local formatter, standard defaults, positive scope and mandatory first verify gate", async () => {
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile("package.json", "utf8")),
    );
    expect(version).toBe("3.9.6");
    expect(JSON.parse(await readFile(".prettierrc.json", "utf8"))).toEqual({});
    expect(await resolveConfig(resolve("src/main.ts"))).toEqual({});
    expect(manifest.scripts.format).toBe(`${invocation} --write ${targets}`);
    expect(manifest.scripts["format:check"]).toBe(
      `${invocation} --check ${targets}`,
    );
    expect(manifest.scripts.verify.split(" && ")[0]).toBe("pnpm format:check");
  });

  it.each([
    ["src/example.ts", "export const value={name:'billing',items:[1,2]};"],
    ["eslint.config.mjs", "export default [{rules:{semi:'error'}}]"],
    ["package.json", '{"name":"billing","private":true}'],
    [
      ".github/workflows/example.yml",
      "name:   Billing\npermissions: {contents: read}\n",
    ],
  ])(
    "rejects unformatted %s and accepts the formatter output idempotently",
    async (filepath, source) => {
      const config = await resolveConfig(resolve(filepath));
      expect(config).toEqual({});
      const options = { ...config, filepath };
      expect(await check(source, options)).toBe(false);
      const formatted = await format(source, options);
      expect(await check(formatted, options)).toBe(true);
      expect(await format(formatted, options)).toBe(formatted);
    },
  );

  it("ignores only the explicit generated/build/lock authorities, not hand-written generated directories", async () => {
    const actual = (await readFile(".prettierignore", "utf8"))
      .trim()
      .split(/\r?\n/u);
    expect(actual).toEqual(ignored);
    const options = {
      ignorePath: resolve(".prettierignore"),
      resolveConfig: false,
    };
    for (const filepath of [
      "src/generated/prisma/client.ts",
      "database/generated/schema.prisma",
      "database/generated/provenance.json",
      "node_modules/example/index.ts",
      "dist/src/main.js",
      "coverage/result.json",
      "pnpm-lock.yaml",
    ]) {
      expect(
        (await getFileInfo(resolve(filepath), options)).ignored,
        filepath,
      ).toBe(true);
    }
    for (const filepath of [
      "src/main.ts",
      "test/unit/example.test.ts",
      "scripts/example.ts",
      "src/modules/generated/handwritten.ts",
      "src/generated/handwritten.ts",
      "test/generated/example.ts",
      ".github/workflows/ci.yml",
    ]) {
      expect(
        (await getFileInfo(resolve(filepath), options)).ignored,
        filepath,
      ).toBe(false);
    }
  });
});

it("keeps the actual route-parity matcher invariant under formatting", async () => {
  const text = await readFile("scripts/verify-openapi.ts", "utf8");
  const file = ts.createSourceFile(
    "verify-openapi.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  let literal: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "routePattern" &&
      node.initializer &&
      ts.isRegularExpressionLiteral(node.initializer)
    )
      literal = node.initializer.text;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!literal) throw new Error("route-pattern-not-found");
  const boundary = literal.lastIndexOf("/");
  const pattern = new RegExp(
    literal.slice(1, boundary),
    literal.slice(boundary + 1),
  );
  const routes = (source: string) =>
    [...source.matchAll(pattern)].map((match) => [match[1], match[2]]);
  for (const source of [
    "app.post('/v1/webhooks/payment/:provider', handler);",
    'app.post(\n  "/v1/webhooks/payment/:provider",\n  handler,\n);',
    'app.post<{ Params: Params }>(\n "/v1/webhooks/payment/:provider", handler);',
  ]) {
    expect(routes(source)).toEqual([
      ["post", "/v1/webhooks/payment/:provider"],
    ]);
    expect(routes(await format(source, { parser: "typescript" }))).toEqual([
      ["post", "/v1/webhooks/payment/:provider"],
    ]);
  }
  expect(routes('app.notARoute("/v1/no");')).toEqual([]);
  expect(routes("app.post(variable, handler);")).toEqual([]);
});
