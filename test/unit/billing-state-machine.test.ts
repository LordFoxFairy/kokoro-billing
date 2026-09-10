import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
} from "../../src/domain/payment/services/billing-state-machine.js";

describe("Billing state machines", () => {
  it("permits only forward payment and admission transitions", () => {
    expect(canTransition("paymentCollection", "authorized", "captured")).toBe(
      true,
    );
    expect(canTransition("paymentCollection", "captured", "authorized")).toBe(
      false,
    );
    expect(canTransition("admission", "unknown", "captured")).toBe(true);
    expect(canTransition("admission", "captured", "released")).toBe(false);
  });

  it("rejects a terminal-state transition", () => {
    expect(() => assertTransition("admission", "released", "captured")).toThrow(
      "billing.invalid_admission_transition",
    );
  });
});
