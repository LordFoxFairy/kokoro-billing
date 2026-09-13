import { randomUUID } from "node:crypto";
import type { AuditAppendInput } from "./audit.types.js";
import { toPersistedJson } from "./persisted-json.js";
import type { TransactionService } from "./transaction.service.js";

export class AuditAppender {
  readonly #transactions: TransactionService;

  constructor(transactions: TransactionService) {
    this.#transactions = transactions;
  }

  async append(input: AuditAppendInput): Promise<string> {
    const { client, scope } = this.#transactions.requireActive(input.tenantId);
    const id = randomUUID();
    await client.billing_audit_event.create({
      data: {
        id,
        tenant_id: input.tenantId,
        operator_id: scope.actorId,
        action: input.action,
        subject_id: input.subjectId ?? null,
        resource_type: input.resourceType,
        resource_id: input.resourceId ?? null,
        reason: input.reason,
        payload_json: toPersistedJson(input.payload),
      },
    });
    return id;
  }
}
