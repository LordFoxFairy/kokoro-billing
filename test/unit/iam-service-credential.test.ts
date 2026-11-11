import { chmod, link, symlink, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readIamServiceCredential } from "../../src/modules/metering/iam-service-credential.js";
import {
  iamCredentialEntry,
  iamServiceCredentialFixture,
} from "../support/iam-service-credential.fixture.js";

const signal = () => new AbortController().signal;
describe("sender-owned IAM service credential snapshot", () => {
  const fixtures: Array<
    Awaited<ReturnType<typeof iamServiceCredentialFixture>>
  > = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  });
  async function setup() {
    const fixture = await iamServiceCredentialFixture();
    fixtures.push(fixture);
    return fixture;
  }
  it("selects exactly the authenticated tenant, never the first entry", async () => {
    const fixture = await setup();
    const a = iamCredentialEntry("tenant-a");
    const b = iamCredentialEntry(
      "tenant-b",
      "other-service-secret-" + "b".repeat(32),
    );
    await fixture.replace({ version: 1, entries: [a, b] });
    expect(
      await readIamServiceCredential(fixture.path, "tenant-b", signal()),
    ).toBe(b.secret);
    await expect(
      readIamServiceCredential(fixture.path, "tenant-c", signal()),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it.each([
    ["empty", { version: 1, entries: [] }],
    [
      "wrong caller",
      {
        version: 1,
        entries: [{ ...iamCredentialEntry(), caller: "kokoro-bff" }],
      },
    ],
    [
      "wrong surface",
      {
        version: 1,
        entries: [{ ...iamCredentialEntry(), surface: "catalog" }],
      },
    ],
    [
      "unknown field",
      {
        version: 1,
        entries: [{ ...iamCredentialEntry(), expires_at: "2099-01-01" }],
      },
    ],
    [
      "ambiguous tenant",
      {
        version: 1,
        entries: [
          iamCredentialEntry(),
          {
            ...iamCredentialEntry(),
            credential_id: "another",
            secret: "x".repeat(32),
          },
        ],
      },
    ],
    [
      "reused secret",
      {
        version: 1,
        entries: [iamCredentialEntry(), iamCredentialEntry("tenant-b")],
      },
    ],
    [
      "short secret",
      { version: 1, entries: [{ ...iamCredentialEntry(), secret: "short" }] },
    ],
    [
      "header delimiter",
      {
        version: 1,
        entries: [{ ...iamCredentialEntry(), secret: "x".repeat(32) + "," }],
      },
    ],
    ["wrong version", { version: 2, entries: [iamCredentialEntry()] }],
  ])("rejects %s without disclosing configuration", async (_name, value) => {
    const fixture = await setup();
    await fixture.replace(value);
    try {
      await readIamServiceCredential(fixture.path, "tenant-a", signal());
      throw new Error("Unexpected credential acceptance");
    } catch (error) {
      expect(error).toMatchObject({
        code: "UNAVAILABLE",
        message: "Billing authorization is unavailable",
      });
      expect(JSON.stringify(error)).not.toContain(iamCredentialEntry().secret);
      expect(String(error)).not.toContain(fixture.path);
    }
  });
  it.each(["tenant_id", "tenant_\\u0069d", "secret"])(
    "rejects duplicate JSON member %s before selecting any credential",
    async (key) => {
      const fixture = await setup();
      const entry = JSON.stringify(iamCredentialEntry());
      const duplicate =
        entry.slice(0, -1) +
        `,"${key}":${JSON.stringify(key === "secret" ? iamCredentialEntry().secret : "tenant-a")}}`;
      await writeFile(fixture.path, `{"version":1,"entries":[${duplicate}]}`);
      await expect(
        readIamServiceCredential(fixture.path, "tenant-a", signal()),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    },
  );
  it("requires a private regular unlinked file and does not follow symlinks", async () => {
    const fixture = await setup();
    await chmod(fixture.path, 0o644);
    await expect(
      readIamServiceCredential(fixture.path, "tenant-a", signal()),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await chmod(fixture.path, 0o600);
    const alias = fixture.path + ".alias";
    await symlink(fixture.path, alias);
    await expect(
      readIamServiceCredential(alias, "tenant-a", signal()),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await unlink(alias);
    await link(fixture.path, alias);
    await expect(
      readIamServiceCredential(fixture.path, "tenant-a", signal()),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await unlink(alias);
    await chmod(fixture.path, 0o400);
    expect(
      await readIamServiceCredential(fixture.path, "tenant-a", signal()),
    ).toBe(iamCredentialEntry().secret);
  });
  it("rejects missing, oversized, malformed UTF-8/JSON and cancelled reads", async () => {
    const fixture = await setup();
    await expect(
      readIamServiceCredential(fixture.path, "tenant-a", AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    for (const raw of [
      Buffer.from([0xff]),
      Buffer.from("{bad"),
      Buffer.alloc(65537, 32),
    ]) {
      await writeFile(fixture.path, raw);
      await expect(
        readIamServiceCredential(fixture.path, "tenant-a", signal()),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    await unlink(fixture.path);
    await expect(
      readIamServiceCredential(fixture.path, "tenant-a", signal()),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
