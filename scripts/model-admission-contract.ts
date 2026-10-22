import { createHash } from "node:crypto";
import previous from "./model-admission-previous.json" with { type: "json" };
/** Exact exp8→exp7 inverse, build/test only. No legacy credential acceptance at runtime. */
export function modelAdmissionProofBaselineSource(source: string): string {
  if (
    createHash("sha256").update(source).digest("hex") !==
    "2c65b64c896a85cb89e6b8f23ee9802b6e5cf2440d9a8debaa23973f5c199b6e"
  )
    throw new Error("Invalid Run-proof admission publication");
  const previous = source
    .replace("version: 4.0.0-experimental.8", "version: 4.0.0-experimental.7")
    .replace(
      "- name: x-billing-execution-proof",
      "- name: x-billing-consumption-token",
    )
    .replace(
      "    OperatorId:\n",
      "    ConsumptionToken:\n      name: x-billing-consumption-token\n      in: header\n      required: true\n      schema:\n        type: string\n        minLength: 1\n        maxLength: 16384\n" +
        "    OperatorId:\n",
    );
  if (
    createHash("sha256").update(previous).digest("hex") !==
    "cdb09146a767a8a1a6d976e2e7d819961a01518370968f671557ff2df4edccc3"
  )
    throw new Error("Billing previous whole-budget canonical changed");
  return previous;
}
/** Build/test-only inverse proof. No retired admission reader or runtime fallback. */
export function modelAdmissionBaselineSource(currentSource: string): string {
  const source = modelAdmissionProofBaselineSource(currentSource);
  if (
    createHash("sha256").update(source).digest("hex") !==
    "cdb09146a767a8a1a6d976e2e7d819961a01518370968f671557ff2df4edccc3"
  )
    throw new Error("Invalid whole-budget admission publication");
  const boundaries = [
    [
      "  /v1/internal/billing/admissions:\n",
      "  /v1/internal/billing/admissions/{admission_id}:\n",
    ],
    [
      "  /v1/internal/billing/admissions/{admission_id}:\n",
      "  /v1/internal/billing/admissions/{admission_id}/capture:\n",
    ],
    ["    AdmissionCreateRequest:\n", "    AdmissionCaptureRequest:\n"],
    ["    Admission:\n", "    AdmissionResponse:\n"],
  ] as const;
  let baseline = source;
  for (const [index, [start, end]] of boundaries.entries()) {
    const a = baseline.indexOf(start),
      b = baseline.indexOf(end, a);
    const old = previous[index];
    if (a < 0 || b <= a || old === undefined)
      throw new Error("Invalid admission inverse binding");
    baseline = baseline.slice(0, a) + old + baseline.slice(b);
  }
  baseline = baseline.replace(
    "version: 4.0.0-experimental.7",
    "version: 4.0.0-experimental.6",
  );
  if (
    createHash("sha256").update(baseline).digest("hex") !==
    "7044102dd6e221338348152bb268eaca6516039cc5ca5122d3c42a096f6dc962"
  )
    throw new Error("Billing previous complete canonical changed");
  return baseline;
}
