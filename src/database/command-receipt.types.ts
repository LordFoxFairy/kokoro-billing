export const commandNamespaces = ["general", "payment", "admission"] as const;
export type CommandNamespace = (typeof commandNamespaces)[number];

export type CommandReceiptRequest = Readonly<{
  tenantId: string;
  namespace: CommandNamespace;
  commandName: string;
  commandIdentity?: string;
  idempotencyKey: string;
  requestSchemaVersion: number;
  payloadDigest: string;
}>;

export type ResultCodec<T> = Readonly<{
  schemaVersion: number;
  encode(value: T): unknown;
  decode(value: unknown): T;
}>;

export type CommandExecution<T> = Readonly<{
  value: T;
  replayed: boolean;
  receiptId: string;
}>;
