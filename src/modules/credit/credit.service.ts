import type { AuditAppender } from "../../database/audit-appender.js";
import type { CommandReceiptRepository } from "../../database/command-receipt.repository.js";
import type { TransactionService } from "../../database/transaction.service.js";
import { commandDigest } from "../../database/canonical-digest.js";
import {
  grantResultCodec,
  reserveResultCodec,
} from "./credit-result-codecs.js";
import type { CreditRepository } from "./credit.repository.js";
import type {
  CaptureCreditInput,
  CreditAccountSnapshot,
  GrantCreditEffectInput,
  GrantCreditInput,
  GrantCreditResult,
  HoldTerminalResult,
  ReleaseCreditInput,
  ReserveCreditEffectInput,
  ReserveCreditInput,
  ReserveCreditResult,
} from "./credit.types.js";

export class CreditEffects {
  constructor(
    private readonly transactions: TransactionService,
    private readonly repository: CreditRepository,
    private readonly audit: AuditAppender,
  ) {}
  async grant(input: GrantCreditEffectInput): Promise<GrantCreditResult> {
    const active = this.transactions.requireActive(input.tenantId);
    return this.transactions.run(active.scope, async () => {
      const result = await this.repository.grant(input);
      await this.audit.append({
        tenantId: input.tenantId,
        action: "credit.grant",
        subjectId: input.subjectId,
        resourceType: "credit_grant",
        resourceId: result.grantId,
        reason: input.sourceKind,
        payload: {
          sourceRef: input.sourceRef,
          programKey: input.programKey,
          amountMicros: input.amountMicros.toString(),
        },
      });
      return result;
    });
  }
  async reserve(input: ReserveCreditEffectInput): Promise<ReserveCreditResult> {
    const active = this.transactions.requireActive(input.tenantId);
    return this.transactions.run(active.scope, async () => {
      const result = await this.repository.reserve(input);
      await this.audit.append({
        tenantId: input.tenantId,
        action: "credit.reserve",
        resourceType: "credit_hold",
        resourceId: result.holdId,
        reason: "usage admission",
        payload: {
          accountId: input.accountId,
          amountMicros: input.requestedMicros.toString(),
        },
      });
      return result;
    });
  }
  async capture(input: CaptureCreditInput): Promise<HoldTerminalResult> {
    const active = this.transactions.requireActive(input.tenantId);
    return this.transactions.run(active.scope, async () => {
      const result = await this.repository.capture(input);
      await this.audit.append({
        tenantId: input.tenantId,
        action: "credit.capture",
        resourceType: "credit_hold",
        resourceId: input.holdId,
        reason: "usage settlement",
        payload: {
          sourceRef: input.sourceRef,
          amountMicros: input.actualMicros.toString(),
        },
      });
      return result;
    });
  }
  async release(input: ReleaseCreditInput): Promise<HoldTerminalResult> {
    const active = this.transactions.requireActive(input.tenantId);
    return this.transactions.run(active.scope, async () => {
      const result = await this.repository.release(input);
      await this.audit.append({
        tenantId: input.tenantId,
        action: "credit.release",
        resourceType: "credit_hold",
        resourceId: input.holdId,
        reason: input.sourceRef,
        payload: { releasedMicros: result.releasedMicros.toString() },
      });
      return result;
    });
  }
  async refreshGrantWindows(
    tenantId: string,
    accountId: string,
  ): Promise<void> {
    const active = this.transactions.requireActive(tenantId);
    return this.transactions.run(active.scope, async () => {
      await this.repository.refreshGrantWindows(tenantId, accountId);
      await this.audit.append({
        tenantId,
        action: "credit.refresh_windows",
        resourceType: "credit_account",
        resourceId: accountId,
        reason: "effective and expiry windows",
        payload: {},
      });
    });
  }
  findAccount(
    tenantId: string,
    accountId: string,
  ): Promise<CreditAccountSnapshot | null> {
    return this.repository.findAccount(tenantId, accountId);
  }
}

export class CreditService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly receipts: CommandReceiptRepository,
    private readonly effects: CreditEffects,
  ) {}
  async grant(input: GrantCreditInput): Promise<GrantCreditResult> {
    const effect: GrantCreditEffectInput = {
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      amountMicros: input.amountMicros,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      programKey: input.programKey,
      effectiveAt: input.effectiveAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.burnPriority === undefined
        ? {}
        : { burnPriority: input.burnPriority }),
    };
    const payloadDigest = commandDigest({
      command: "credit.grant/v1",
      ...effect,
    });
    return this.transactions.runRoot(
      {
        tenantId: input.tenantId,
        actorId: input.actorId,
        operation: "credit.grant",
        mode: "write",
      },
      async () =>
        (
          await this.receipts.execute(
            {
              tenantId: input.tenantId,
              namespace: "general",
              commandName: "credit.grant",
              ...(input.commandIdentity === undefined
                ? {}
                : { commandIdentity: input.commandIdentity }),
              idempotencyKey: input.idempotencyKey,
              requestSchemaVersion: 1,
              payloadDigest,
            },
            grantResultCodec,
            () => this.effects.grant(effect),
          )
        ).value,
    );
  }
  async reserve(input: ReserveCreditInput): Promise<ReserveCreditResult> {
    const effect: ReserveCreditEffectInput = {
      tenantId: input.tenantId,
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      requestedMicros: input.requestedMicros,
      expiresAt: input.expiresAt,
      ...(input.featureKey === undefined
        ? {}
        : { featureKey: input.featureKey }),
    };
    const payloadDigest = commandDigest({
      command: "credit.reserve/v1",
      ...effect,
    });
    const result = await this.transactions.runRoot(
      {
        tenantId: input.tenantId,
        actorId: input.actorId,
        operation: "credit.reserve",
        mode: "write",
      },
      () =>
        this.receipts.execute(
          {
            tenantId: input.tenantId,
            namespace: "admission",
            commandName: "credit.reserve",
            ...(input.commandIdentity === undefined
              ? {}
              : { commandIdentity: input.commandIdentity }),
            idempotencyKey: input.idempotencyKey,
            requestSchemaVersion: 1,
            payloadDigest,
          },
          reserveResultCodec,
          async () => {
            const value = await this.effects.reserve(effect);
            return {
              holdId: value.holdId,
              requestedMicros: value.requestedMicros.toString(),
            };
          },
        ),
    );
    return {
      holdId: result.value.holdId,
      requestedMicros: BigInt(result.value.requestedMicros),
    };
  }
  getAccount(
    tenantId: string,
    accountId: string,
  ): Promise<CreditAccountSnapshot | null> {
    return this.transactions.readRoot(async (client) => {
      const row = await client.billing_credit_account.findFirst({
        where: { id: accountId, tenant_id: tenantId },
      });
      return row
        ? {
            id: row.id,
            tenantId: row.tenant_id,
            subjectId: row.subject_id,
            status: row.status,
            availableMicros: row.available_micros,
            heldMicros: row.held_micros,
          }
        : null;
    });
  }
}
