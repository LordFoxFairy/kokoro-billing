import {
  resolveAgentUsageReaderOptions,
  type AgentUsageReaderOptions,
} from "./agent-usage-evidence-reader.options.js";
import {
  resolveIamBillingAuthorizationOptions,
  type IamBillingAuthorizationOptions,
} from "./iam-billing-authorization.options.js";
export const MODEL_ADMISSION_DEADLINE = Symbol("MODEL_ADMISSION_DEADLINE");
export type ModelAdmissionOptions = Readonly<{
  agent: AgentUsageReaderOptions;
  iam: IamBillingAuthorizationOptions;
  requestDeadlineMs: number;
}>;
export function resolveModelAdmissionOptions(options: ModelAdmissionOptions) {
  if (
    !Number.isSafeInteger(options.requestDeadlineMs) ||
    options.requestDeadlineMs < 1 ||
    options.requestDeadlineMs > 2147483647
  )
    throw new Error("Invalid model admission deadline");
  return Object.freeze({
    agent: resolveAgentUsageReaderOptions(options.agent),
    iam: resolveIamBillingAuthorizationOptions(options.iam),
    requestDeadlineMs: options.requestDeadlineMs,
  });
}
