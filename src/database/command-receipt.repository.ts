import { randomUUID } from "node:crypto";
import { CommandReceiptError } from "./command-receipt.error.js";
import type {
  CommandExecution,
  CommandReceiptRequest,
  ResultCodec,
} from "./command-receipt.types.js";
import type { TransactionService } from "./transaction.service.js";
import { toPersistedJson } from "./persisted-json.js";

export class CommandReceiptRepository {
  readonly #transactions: TransactionService;

  constructor(transactions: TransactionService) {
    this.#transactions = transactions;
  }

  async execute<T>(
    request: CommandReceiptRequest,
    codec: ResultCodec<T>,
    effect: () => Promise<T>,
  ): Promise<CommandExecution<T>> {
    const active = this.#transactions.requireActive(request.tenantId);
    return await this.#transactions.run(active.scope, () =>
      this.#execute(request, codec, effect),
    );
  }

  async #execute<T>(
    request: CommandReceiptRequest,
    codec: ResultCodec<T>,
    effect: () => Promise<T>,
  ): Promise<CommandExecution<T>> {
    const { client } = this.#transactions.requireActive(request.tenantId);
    this.#validate(request, codec);
    const locks = [
      `command:key:${request.tenantId}:${request.namespace}:${request.commandName}:${request.idempotencyKey}`,
      ...(request.commandIdentity
        ? [
            `command:identity:${request.tenantId}:${request.namespace}:${request.commandName}:${request.commandIdentity}`,
          ]
        : []),
    ].sort();
    for (const lock of locks)
      await client.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    const key = await client.billing_command_key_binding.findUnique({
      where: {
        tenant_id_command_namespace_api_surface_command_name_idempotency_key: {
          tenant_id: request.tenantId,
          command_namespace: request.namespace,
          api_surface: "internal",
          command_name: request.commandName,
          idempotency_key: request.idempotencyKey,
        },
      },
    });
    const identity = request.commandIdentity
      ? await client.billing_command_receipt.findFirst({
          where: {
            tenant_id: request.tenantId,
            command_namespace: request.namespace,
            api_surface: "internal",
            command_name: request.commandName,
            command_identity: request.commandIdentity,
          },
        })
      : null;
    const keyed = key
      ? await client.billing_command_receipt.findUnique({
          where: { id: key.command_receipt_id },
        })
      : null;
    if (key && keyed === null)
      throw new CommandReceiptError(
        "COMMAND_RECEIPT_CORRUPT",
        "Command key binding has no receipt",
      );
    if (keyed) this.#assertScope(keyed, request);
    if (keyed && identity && keyed.id !== identity.id) this.#conflict();
    const receipt = keyed ?? identity;
    if (receipt) {
      this.#match(receipt, request);
      if (receipt.status !== "succeeded")
        throw new CommandReceiptError(
          "COMMAND_RECEIPT_INCOMPLETE",
          "Existing command receipt is not complete",
        );
      if (receipt.result_schema_version !== codec.schemaVersion)
        throw new CommandReceiptError(
          "COMMAND_RECEIPT_CORRUPT",
          "Command result schema version is invalid",
        );
      let value: T;
      try {
        value = codec.decode(receipt.result_json);
      } catch (error) {
        throw new CommandReceiptError(
          "COMMAND_RECEIPT_CORRUPT",
          "Command result cannot be decoded",
          { cause: error },
        );
      }
      if (!key)
        await client.billing_command_key_binding.create({
          data: this.#binding(request, receipt.id),
        });
      return { value, replayed: true, receiptId: receipt.id };
    }
    const receiptId = randomUUID();
    await client.billing_command_receipt.create({
      data: {
        id: receiptId,
        tenant_id: request.tenantId,
        command_namespace: request.namespace,
        api_surface: "internal",
        command_name: request.commandName,
        command_identity: request.commandIdentity ?? null,
        request_schema_version: request.requestSchemaVersion,
        payload_digest: request.payloadDigest,
        status: "processing",
      },
    });
    await client.billing_command_key_binding.create({
      data: this.#binding(request, receiptId),
    });
    const value = await effect();
    const encoded = codec.encode(value);
    const result = await client.billing_command_receipt.updateMany({
      where: { id: receiptId, status: "processing" },
      data: {
        status: "succeeded",
        result_schema_version: codec.schemaVersion,
        result_json: toPersistedJson(encoded),
        updated_at: new Date(),
      },
    });
    if (result.count !== 1)
      throw new CommandReceiptError(
        "COMMAND_RECEIPT_INCOMPLETE",
        "Command receipt completion lost ownership",
      );
    return { value, replayed: false, receiptId };
  }

  #binding(request: CommandReceiptRequest, receiptId: string) {
    return {
      id: randomUUID(),
      tenant_id: request.tenantId,
      command_namespace: request.namespace,
      api_surface: "internal",
      command_name: request.commandName,
      idempotency_key: request.idempotencyKey,
      command_receipt_id: receiptId,
    };
  }

  #match(
    receipt: {
      tenant_id: string;
      command_namespace: string;
      api_surface: string;
      command_name: string;
      command_identity: string | null;
      request_schema_version: number;
      payload_digest: string;
    },
    request: CommandReceiptRequest,
  ): void {
    this.#assertScope(receipt, request);
    if (
      receipt.command_identity !== (request.commandIdentity ?? null) ||
      receipt.request_schema_version !== request.requestSchemaVersion ||
      receipt.payload_digest !== request.payloadDigest
    )
      this.#conflict();
  }

  #assertScope(
    receipt: {
      tenant_id: string;
      command_namespace: string;
      api_surface: string;
      command_name: string;
    },
    request: CommandReceiptRequest,
  ): void {
    if (
      receipt.tenant_id !== request.tenantId ||
      receipt.command_namespace !== request.namespace ||
      receipt.api_surface !== "internal" ||
      receipt.command_name !== request.commandName
    )
      throw new CommandReceiptError(
        "COMMAND_RECEIPT_CORRUPT",
        "Command key binding points outside its scope",
      );
  }

  #conflict(): never {
    throw new CommandReceiptError(
      "COMMAND_IDEMPOTENCY_CONFLICT",
      "Command key or identity belongs to another payload",
    );
  }

  #validate(request: CommandReceiptRequest, codec: ResultCodec<unknown>): void {
    if (
      !request.idempotencyKey ||
      !request.commandName ||
      request.payloadDigest.length !== 64 ||
      request.requestSchemaVersion < 1 ||
      codec.schemaVersion < 1
    )
      throw new TypeError("Invalid command receipt request");
  }
}
