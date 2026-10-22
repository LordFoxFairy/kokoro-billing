import { resolveModelAdmissionOptions } from "../modules/metering/model-admission.options.js";
export function readModelAdmissionConfig(env: NodeJS.ProcessEnv) {
  const enabled = env.BILLING_MODEL_ADMISSION_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false")
    throw new Error("BILLING_MODEL_ADMISSION_ENABLED must be true or false");
  if (enabled === "false") return undefined;
  const required = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  try {
    return resolveModelAdmissionOptions({
      agent: {
        baseUrl: required("BILLING_AGENT_BASE_URL"),
        machineBearerToken: required("BILLING_AGENT_READER_TOKEN"),
        deadlineMs: 2000,
      },
      iam: {
        baseUrl: required("BILLING_IAM_BASE_URL"),
        machineBearerToken: required("BILLING_IAM_AUTHORIZATION_TOKEN"),
        deadlineMs: 2000,
      },
      requestDeadlineMs: Number(
        env.BILLING_MODEL_ADMISSION_DEADLINE_MS ?? 10000,
      ),
    });
  } catch {
    throw new Error("Invalid explicit model admission configuration");
  }
}
