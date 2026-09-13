import { Prisma } from "../generated/prisma/client.js";

export function toPersistedJson(value: unknown) {
  assertJsonValue(value, new WeakSet<object>(), "$");
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function assertJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  path: string,
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} must be a finite JSON number`);
  }
  if (typeof value !== "object")
    throw new TypeError(`${path} is not a JSON value`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    throw new TypeError(`${path} must be a plain JSON object`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length)
        throw new TypeError(`${path} must be a dense JSON array`);
      for (const [index, item] of value.entries())
        assertJsonValue(item, ancestors, `${path}[${index}]`);
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string")
        throw new TypeError(`${path} contains a symbol key`);
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      )
        throw new TypeError(
          `${path}.${key} is not an enumerable data property`,
        );
      assertJsonValue(descriptor.value, ancestors, `${path}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}
