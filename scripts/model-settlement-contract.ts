import { modelAdmissionRecoveryBaselineSource } from "./model-admission-recovery-contract.js";
import { createHash } from "node:crypto";
import previous from "./model-settlement-previous.json" with { type: "json" };
/** Build/test-only exact exp9→8 inverse. No retired runtime handlers or compatibility parser. */
export function modelSettlementBaselineSource(currentSource: string): string {
  const source = modelAdmissionRecoveryBaselineSource(currentSource);
  if (
    createHash("sha256").update(source).digest("hex") !==
    "7b5335fde2be601b2d6256cb9b68b0964d5518cfa053b50f2029358a059a0924"
  )
    throw new Error("Invalid sealed model settlement publication");
  const ranges = [
    [
      "  /v1/internal/billing/admissions/{admission_id}/settle:\n",
      "  /v1/internal/billing/execution-events:\n",
    ],
    ["    AdmissionSettlementRequest:\n", "    Admission:\n"],
  ] as const;
  let baseline = source;
  for (const [i, [start, end]] of ranges.entries()) {
    const a = baseline.indexOf(start),
      b = baseline.indexOf(end, a),
      old = previous[i];
    if (
      a < 0 ||
      b <= a ||
      typeof old !== "string" ||
      baseline.indexOf(start, a + start.length) !== -1
    )
      throw new Error("Invalid settlement inverse boundary");
    baseline = baseline.slice(0, a) + old + baseline.slice(b);
  }
  baseline = baseline.replace(
    "version: 4.0.0-experimental.9",
    "version: 4.0.0-experimental.8",
  );
  if (
    createHash("sha256").update(baseline).digest("hex") !==
    "2c65b64c896a85cb89e6b8f23ee9802b6e5cf2440d9a8debaa23973f5c199b6e"
  )
    throw new Error("Original complete model-budget canonical changed");
  return baseline;
}
