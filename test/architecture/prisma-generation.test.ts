import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readBillingDependencyGraph } from "./typescript-dependency-project.js";
import { checkBillingDependencies } from "./billing-dependency-policy.js";

describe("Prisma generation boundary", () => {
  it("limits production Prisma imports to the approved database components", async () => {
    const graph = await readBillingDependencyGraph();
    expect(graph.diagnostics).toEqual([]);
    expect(
      checkBillingDependencies(graph).filter(
        (item) => item.code === "production-prisma",
      ),
    ).toEqual([]);
    const scripts = JSON.stringify(
      (
        JSON.parse(await readFile("package.json", "utf8")) as {
          scripts: Record<string, string>;
        }
      ).scripts,
    );
    expect(scripts).not.toMatch(/db push|migrate/iu);
  });
});
