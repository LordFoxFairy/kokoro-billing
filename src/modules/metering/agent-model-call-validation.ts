import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";

/** Exact owner extensions shared by both metering evidence codecs. */
export function createAgentModelCallValidator() {
  const ajv = new Ajv2020({ strict: true, ownProperties: true });
  for (const keyword of [
    "x-artifact-version",
    "x-max-json-bytes",
    "x-max-json-depth",
  ])
    ajv.addKeyword(keyword);
  ajv.addKeyword({
    keyword: "x-utf8-max-bytes",
    type: "string",
    schemaType: "number",
    validate: (limit: number, value: string) =>
      Buffer.byteLength(value, "utf8") <= limit,
  });
  ajv.addKeyword({
    keyword: "x-max-decimal",
    type: "string",
    schemaType: "string",
    validate: (limit: string, value: string) =>
      /^(0|[1-9][0-9]*)$/u.test(value) &&
      value.length <= limit.length &&
      BigInt(value) <= BigInt(limit),
  });
  ajv.addKeyword({
    keyword: "x-calendar-valid",
    type: "string",
    schemaType: "boolean",
    validate: (_enabled: boolean, value: string) => {
      if (
        !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(
          value,
        )
      )
        return false;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) && date.toISOString() === value;
    },
  });

  formatsModule.default(ajv);
  return ajv;
}
