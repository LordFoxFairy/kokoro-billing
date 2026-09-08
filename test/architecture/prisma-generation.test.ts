import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Prisma generation boundary", () => {
  it("keeps production source free of Prisma imports before the B8 cutover", async () => {
    const production: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === "generated") continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".ts"))
          production.push(await readFile(path, "utf8"));
      }
    }
    await walk(resolve("src"));
    expect(production.join("\n")).not.toMatch(/@prisma|generated\/prisma/iu);
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
