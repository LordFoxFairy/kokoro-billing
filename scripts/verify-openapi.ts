import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { assertTargetOpenApi } from "./openapi-target.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const source = await readFile(
  resolve(root, "contract/openapi/v1/openapi.yaml"),
  "utf8",
);
const readme = await readFile(resolve(root, "contract/README.md"), "utf8");
const digest = createHash("sha256").update(source).digest("hex");
if (!readme.includes(digest))
  throw new Error(`contract/README.md provenance digest must be ${digest}`);
assertTargetOpenApi(parse(source) as Record<string, unknown>);
process.stdout.write("Billing OpenAPI v1 contract is valid: 24 operations\n");
