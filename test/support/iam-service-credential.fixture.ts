import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const iamCredentialEntry = (
  tenantId = "tenant-a",
  secret = "fixture-service-secret-" + "a".repeat(32),
) => ({
  credential_id: `billing-${tenantId}`,
  caller: "kokoro-billing",
  surface: "billing_authorization",
  tenant_id: tenantId,
  secret,
});

export async function iamServiceCredentialFixture(
  entries = [iamCredentialEntry()],
) {
  const directory = await mkdtemp(join(tmpdir(), "billing-iam-credential-"));
  const path = join(directory, "credentials.json");
  const replace = async (value: unknown) => {
    const next = join(directory, "next.json");
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, path);
  };
  try {
    await replace({ version: 1, entries });
    return {
      path,
      replace,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
