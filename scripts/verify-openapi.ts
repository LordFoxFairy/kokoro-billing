import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCreditAccountContract } from "./credit-account-contract.js";
import { assertAgentUsageConsumerPin } from "./agent-usage-consumer-pin.js";
import { generateAgentUsageArtifacts } from "./generate-agent-usage.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const consumerPin = await readFile(
  resolve(root, "contract/agent/usage/v2/consumer-pin.json"),
).catch(() => {
  throw new Error("Agent usage consumer pin is unavailable");
});
assertAgentUsageConsumerPin(consumerPin);
const source = await readFile(
  resolve(root, "contract/openapi/v1/openapi.yaml"),
  "utf8",
);
const readme = await readFile(resolve(root, "contract/README.md"), "utf8");
const digest = createHash("sha256").update(source).digest("hex");
if (!readme.includes(digest))
  throw new Error(`contract/README.md provenance digest must be ${digest}`);
assertCreditAccountContract(source);
await generateAgentUsageArtifacts(root, true);
process.stdout.write("Billing OpenAPI v1 contract is valid: 25 operations\n");
