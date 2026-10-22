import { describe, expect, test } from "vitest";
import { readModelAdmissionConfig } from "../../src/config/model-admission-config.js";
const enabled = {
  BILLING_MODEL_ADMISSION_ENABLED: "true",
  BILLING_AGENT_BASE_URL: "http://127.0.0.1:1",
  BILLING_AGENT_READER_TOKEN: "agent-canary-secret",
  BILLING_IAM_BASE_URL: "http://127.0.0.1:2",
  BILLING_IAM_AUTHORIZATION_TOKEN: "iam-canary-secret",
};
describe("explicit model admission runtime activation", () => {
  test("default and explicit disabled do not activate based on credential presence", () => {
    expect(readModelAdmissionConfig({})).toBeUndefined();
    expect(
      readModelAdmissionConfig({
        ...enabled,
        BILLING_MODEL_ADMISSION_ENABLED: "false",
      }),
    ).toBeUndefined();
  });
  test("full explicit configuration validates both peers and hides their machine credentials from serialization", () => {
    const value = readModelAdmissionConfig(enabled);
    expect(value?.requestDeadlineMs).toBe(10000);
    expect(value?.agent.deadlineMs).toBe(2000);
    expect(JSON.stringify(value)).not.toContain("canary-secret");
    expect(value?.agent.machineBearerToken).toBe(
      enabled.BILLING_AGENT_READER_TOKEN,
    );
    expect(value?.iam.machineBearerToken).toBe(
      enabled.BILLING_IAM_AUTHORIZATION_TOKEN,
    );
  });
  test.each(["TRUE", "1", ""])("rejects ambiguous enable flag %s", (flag) => {
    expect(() =>
      readModelAdmissionConfig({
        ...enabled,
        BILLING_MODEL_ADMISSION_ENABLED: flag,
      }),
    ).toThrow();
  });
  test.each(["0", "-1", "1.2", "2147483648"])(
    "rejects invalid total deadline %s",
    (deadline) => {
      expect(() =>
        readModelAdmissionConfig({
          ...enabled,
          BILLING_MODEL_ADMISSION_DEADLINE_MS: deadline,
        }),
      ).toThrow();
    },
  );
  test("rejects missing peer settings and non-origin URLs without disclosing configuration", () => {
    for (const settings of [
      { BILLING_MODEL_ADMISSION_ENABLED: "true" },
      {
        ...enabled,
        BILLING_AGENT_BASE_URL:
          "http://127.0.0.1:1/private?secret=canary-secret",
      },
    ]) {
      try {
        readModelAdmissionConfig(settings);
        throw new Error("unexpected success");
      } catch (error) {
        expect(String(error)).toContain(
          "Invalid explicit model admission configuration",
        );
        expect(String(error)).not.toContain("canary-secret");
      }
    }
  });
});
