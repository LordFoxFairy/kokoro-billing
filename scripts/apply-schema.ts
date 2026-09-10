import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCanonicalSchema } from "./canonical-schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "DATABASE_URL is required and must be a PostgreSQL connection string",
  );

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const schemaPath = resolve(scriptDirectory, "..", "database", "schema.sql");
const schema = await readFile(schemaPath, "utf8");
if (schema.trim() === "")
  throw new Error("database/schema.sql must not be empty");

await installCanonicalSchema({ databaseUrl, schemaSql: schema });
console.log(`installed canonical schema: ${schemaPath}`);
