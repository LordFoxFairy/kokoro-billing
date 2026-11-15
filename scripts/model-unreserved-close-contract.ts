import { createHash } from "node:crypto";
import { parse } from "yaml";
// Build-only additive-surface proof; no runtime legacy reader.
export function modelUnreservedCloseBaselineSource(source: string): string {
  if (!source.includes("version: 4.0.0-experimental.11")) return source;
  const d = parse(source) as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  const names = [
    "AdmissionUnreservedCloseRequest",
    "AdmissionUnreservedClosure",
    "AdmissionUnreservedCloseResponse",
  ];
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  const profile = {
    path: d.paths["/v1/internal/billing/admissions/close-unreserved"],
    schemas: Object.fromEntries(names.map((n) => [n, d.components.schemas[n]])),
  };
  if (
    createHash("sha256")
      .update(JSON.stringify(stable(profile)))
      .digest("hex") !==
    "0f0bc0efcc756032fcf673e3bda86ee874fc727e544be008e757cff8c1443554"
  )
    throw new Error("Invalid unreserved close surface");
  const previous = source
    .replace("version: 4.0.0-experimental.11", "version: 4.0.0-experimental.10")
    .replace(
      /^ {2}\/v1\/internal\/billing\/admissions\/close-unreserved:\n[\s\S]*?(?=^ {2}\/v1\/internal\/billing\/admissions\/recover:\n)/mu,
      "",
    )
    .replace(
      /^ {4}AdmissionUnreservedCloseRequest:\n[\s\S]*?(?=^ {4}ExecutionEventRequest:\n)/mu,
      "",
    );
  if (
    createHash("sha256").update(previous).digest("hex") !==
    "f3d510bbf084d0dddad91d8cfafd13caf19e23c2a97074b363e0687291e14654"
  )
    throw new Error("Original exp10 canonical changed");
  return previous;
}
