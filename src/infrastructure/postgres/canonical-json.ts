import { createHash } from 'node:crypto';

const invalidJson = (): never => {
  throw new Error('billing.command_payload_not_json');
};

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Reflect.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
};

const serialize = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : invalidJson();
  if (typeof value !== 'object') return invalidJson();
  if (ancestors.has(value)) return invalidJson();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return invalidJson();
        items.push(serialize(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }

    if (!isPlainRecord(value)) return invalidJson();
    const fields = Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return invalidJson();
      return `${JSON.stringify(key)}:${serialize(value[key], ancestors)}`;
    });
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
};

/** Deterministic JSON for durable command identity; arrays retain caller order. */
export const canonicalJson = (value: unknown): string => serialize(value, new Set());

export const canonicalJsonDigest = (value: unknown): string => createHash('sha256')
  .update(canonicalJson(value), 'utf8')
  .digest('hex');
