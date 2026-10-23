import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { parseStrictMeteringJson } from "./strict-metering-json.js";
import { IamBillingAuthorizationError } from "./iam-billing-authorization.error.js";

const snapshotSchema = z
  .object({
    version: z.literal(1),
    entries: z
      .array(
        z
          .object({
            credential_id: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
            caller: z.literal("kokoro-billing"),
            surface: z.literal("billing_authorization"),
            tenant_id: z
              .string()
              .min(1)
              .max(255)
              .regex(/^\S+$/u)
              .refine((value) =>
                Array.from(value).every((character) => {
                  const point = character.codePointAt(0) ?? 0;
                  return point >= 32 && point !== 127;
                }),
              ),
            secret: z
              .string()
              .min(32)
              .max(4096)
              .regex(/^[\x21-\x7e]+$/u)
              .refine((value) => !value.includes(",")),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

/** Sender-local configuration, freshly read per authorization; no OAuth or decision cache. */
async function readSnapshot(
  path: string,
  tenantId: string,
  signal: AbortSignal,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal.throwIfAborted();
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    signal.throwIfAborted();
    const before = await handle.stat();
    signal.throwIfAborted();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.geteuid?.() ||
      ![0o400, 0o600].includes(before.mode & 0o777) ||
      before.size > 65536
    )
      throw new Error("Invalid credential file");
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      size > 65536 ||
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.nlink !== 1
    )
      throw new Error("Credential changed during read");
    const snapshot = snapshotSchema.parse(
      parseStrictMeteringJson(bytes.subarray(0, size), 65536, 8, true).value,
    );
    for (const key of ["credential_id", "tenant_id", "secret"] as const) {
      if (
        new Set(snapshot.entries.map((entry) => entry[key])).size !==
        snapshot.entries.length
      )
        throw new Error("Ambiguous credential configuration");
    }
    const entry = snapshot.entries.find(
      (candidate) => candidate.tenant_id === tenantId,
    );
    if (!entry) throw new Error("No credential for tenant");
    signal.throwIfAborted();
    return entry.secret;
  } catch {
    throw new IamBillingAuthorizationError("UNAVAILABLE");
  } finally {
    await handle?.close();
  }
}

/** A cancelled caller need not wait for filesystem IO; its late handle is still closed by readSnapshot. */
export function readIamServiceCredential(
  path: string,
  tenantId: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new IamBillingAuthorizationError("UNAVAILABLE"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void readSnapshot(path, tenantId, signal).then(
      (credential) => {
        signal.removeEventListener("abort", abort);
        resolve(credential);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(new IamBillingAuthorizationError("UNAVAILABLE"));
      },
    );
  });
}
