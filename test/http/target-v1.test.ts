import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
// v1 wire aliases were intentionally retired. Business receipt/replay assertions
// are retained at service boundaries, not in a second transport implementation.
describe("retired v1 transport", () => {
  it("has no production transport source to select instead of the canonical root", async () => {
    await expect(
      readFile(
        new URL("../../src/interfaces/http/server.ts", import.meta.url),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
