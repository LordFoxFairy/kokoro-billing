import { createHash } from "node:crypto";
/** Build/test only: remove the single recover-only publication delta, preserving the complete original exp9. */
export function modelAdmissionRecoveryBaselineSource(source: string): string {
  if (
    createHash("sha256").update(source).digest("hex") !==
    "f3d510bbf084d0dddad91d8cfafd13caf19e23c2a97074b363e0687291e14654"
  )
    throw new Error("Invalid recovery-only publication");
  const marker = "  /v1/internal/billing/admissions/recover:\n",
    end = "  /v1/internal/billing/admissions/{admission_id}:\n";
  const a = source.indexOf(marker),
    b = source.indexOf(end, a);
  if (a < 0 || b <= a || source.indexOf(marker, a + marker.length) !== -1)
    throw new Error("Invalid recover-only inverse boundary");
  const baseline = (source.slice(0, a) + source.slice(b)).replace(
    "version: 4.0.0-experimental.10",
    "version: 4.0.0-experimental.9",
  );
  if (
    createHash("sha256").update(baseline).digest("hex") !==
    "7b5335fde2be601b2d6256cb9b68b0964d5518cfa053b50f2029358a059a0924"
  )
    throw new Error("Original complete settlement publication changed");
  return baseline;
}
