import { randomUUID } from "node:crypto";
import type { TransactionService } from "../../database/transaction.service.js";
import { CreditError } from "./credit.error.js";
import type {
  CaptureCreditInput,
  CreditAccountSnapshot,
  GrantCreditEffectInput,
  GrantCreditResult,
  HoldTerminalResult,
  ReleaseCreditInput,
  ReserveCreditEffectInput,
  ReserveCreditResult,
} from "./credit.types.js";

export class CreditRepository {
  constructor(private readonly transactions: TransactionService) {}

  async findAccount(
    tenantId: string,
    accountId: string,
  ): Promise<CreditAccountSnapshot | null> {
    const client = this.transactions.requireActiveTransaction(
      tenantId,
      "write",
    );
    const row = await client.billing_credit_account.findFirst({
      where: { id: accountId, tenant_id: tenantId },
    });
    return (
      row && {
        id: row.id,
        tenantId: row.tenant_id,
        subjectId: row.subject_id,
        status: row.status,
        availableMicros: row.available_micros,
        heldMicros: row.held_micros,
      }
    );
  }

  async grant(input: GrantCreditEffectInput): Promise<GrantCreditResult> {
    this.#positive(input.amountMicros);
    const client = this.transactions.requireActiveTransaction(
      input.tenantId,
      "write",
    );
    await client.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${`credit:subject:${input.tenantId}:${input.subjectId}`}, 0))`;
    let account = await client.billing_credit_account.findFirst({
      where: { tenant_id: input.tenantId, subject_id: input.subjectId },
    });
    if (!account)
      account = await client.billing_credit_account.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenantId,
          subject_id: input.subjectId,
        },
      });
    const accountRows = await client.$queryRaw<
      Array<{ id: string; status: string }>
    >`SELECT id, status FROM billing_credit_account WHERE id=${account.id}::uuid AND tenant_id=${input.tenantId} FOR UPDATE`;
    account = { ...account, status: accountRows[0]?.status ?? account.status };
    if (account.status !== "active")
      throw new CreditError(
        "CREDIT_ACCOUNT_DISABLED",
        "Credit account is disabled",
      );
    const prior = await client.billing_credit_grant.findFirst({
      where: {
        tenant_id: input.tenantId,
        source_kind: input.sourceKind,
        source_ref: input.sourceRef,
      },
    });
    if (prior) {
      if (
        prior.credit_account_id !== account.id ||
        prior.program_key !== input.programKey ||
        prior.original_micros !== input.amountMicros ||
        prior.effective_at.getTime() !== input.effectiveAt.getTime() ||
        (prior.expires_at?.getTime() ?? null) !==
          (input.expiresAt?.getTime() ?? null)
      )
        throw new CreditError(
          "CREDIT_IDEMPOTENCY_CONFLICT",
          "Grant source belongs to another payload",
        );
      const journal = await client.billing_credit_journal.findFirstOrThrow({
        where: {
          tenant_id: input.tenantId,
          source_kind: input.sourceKind,
          source_ref: input.sourceRef,
          entry_kind: "grant",
        },
      });
      return {
        accountId: account.id,
        grantId: prior.id,
        journalId: journal.id,
      };
    }
    const grantId = randomUUID();
    const journalId = randomUUID();
    const seq = await this.#nextJournalSeq(input.tenantId, account.id);
    await client.billing_credit_grant.create({
      data: {
        id: grantId,
        tenant_id: input.tenantId,
        credit_account_id: account.id,
        source_kind: input.sourceKind,
        source_ref: input.sourceRef,
        program_key: input.programKey,
        original_micros: input.amountMicros,
        remaining_micros: input.amountMicros,
        effective_at: input.effectiveAt,
        expires_at: input.expiresAt ?? null,
        burn_priority: input.burnPriority ?? 0,
        status: input.effectiveAt <= new Date() ? "active" : "pending",
      },
    });
    if (input.effectiveAt <= new Date())
      await client.billing_credit_account.update({
        where: { id: account.id },
        data: {
          available_micros: { increment: input.amountMicros },
          generation: { increment: 1 },
          updated_at: new Date(),
        },
      });
    await client.billing_credit_journal.create({
      data: {
        id: journalId,
        tenant_id: input.tenantId,
        credit_account_id: account.id,
        journal_seq: seq,
        entry_kind: "grant",
        amount_micros: input.amountMicros,
        source_kind: input.sourceKind,
        source_ref: input.sourceRef,
      },
    });
    return { accountId: account.id, grantId, journalId };
  }

  async reserve(input: ReserveCreditEffectInput): Promise<ReserveCreditResult> {
    this.#positive(input.requestedMicros);
    const client = this.transactions.requireActiveTransaction(
      input.tenantId,
      "write",
    );
    const prior = await client.billing_credit_hold.findFirst({
      where: {
        tenant_id: input.tenantId,
        idempotency_key: input.idempotencyKey,
      },
    });
    if (prior) {
      if (
        prior.credit_account_id !== input.accountId ||
        prior.requested_micros !== input.requestedMicros ||
        prior.feature_key !== (input.featureKey ?? null)
      )
        throw new CreditError(
          "CREDIT_IDEMPOTENCY_CONFLICT",
          "Hold key belongs to another payload",
        );
      return { holdId: prior.id, requestedMicros: prior.requested_micros };
    }
    const locked = await client.$queryRaw<
      Array<{ id: string; status: string; available_micros: bigint }>
    >`SELECT id, status, available_micros FROM billing_credit_account WHERE id=${input.accountId}::uuid AND tenant_id=${input.tenantId} FOR UPDATE`;
    const account = locked[0];
    if (!account)
      throw new CreditError(
        "CREDIT_ACCOUNT_NOT_FOUND",
        "Credit account was not found",
      );
    if (account.status !== "active")
      throw new CreditError(
        "CREDIT_ACCOUNT_DISABLED",
        "Credit account is disabled",
      );
    await client.$queryRaw`SELECT id FROM billing_credit_grant WHERE tenant_id=${input.tenantId} AND credit_account_id=${input.accountId}::uuid ORDER BY id FOR UPDATE`;
    await this.refreshGrantWindows(input.tenantId, input.accountId);
    const refreshed = await client.billing_credit_account.findUniqueOrThrow({
      where: { id: input.accountId },
    });
    if (refreshed.available_micros < input.requestedMicros)
      throw new CreditError(
        "CREDIT_INSUFFICIENT",
        "Credit balance is insufficient",
      );
    const grants = await client.$queryRaw<
      Array<{ id: string; allocatable_micros: bigint }>
    >`SELECT g.id, g.remaining_micros - COALESCE(SUM(a.held_micros-a.captured_micros-a.released_micros) FILTER (WHERE h.status='active'),0)::bigint AS allocatable_micros
       FROM billing_credit_grant g
       LEFT JOIN billing_credit_hold_allocation a ON a.credit_grant_id=g.id
       LEFT JOIN billing_credit_hold h ON h.id=a.credit_hold_id AND h.tenant_id=g.tenant_id
       WHERE g.tenant_id=${input.tenantId} AND g.credit_account_id=${input.accountId}::uuid AND g.status='active'
         AND g.effective_at <= clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
       GROUP BY g.id, g.remaining_micros, g.expires_at, g.burn_priority, g.issued_at
       ORDER BY g.expires_at NULLS LAST, g.burn_priority, g.issued_at, g.id`;
    let remaining = input.requestedMicros;
    const allocations: Array<{ grantId: string; amount: bigint }> = [];
    for (const grant of grants) {
      const amount =
        grant.allocatable_micros < remaining
          ? grant.allocatable_micros
          : remaining;
      if (amount > 0n) allocations.push({ grantId: grant.id, amount });
      remaining -= amount;
      if (remaining === 0n) break;
    }
    if (remaining !== 0n)
      throw new CreditError(
        "CREDIT_INSUFFICIENT",
        "Eligible grants are insufficient",
      );
    const holdId = randomUUID();
    await client.billing_credit_hold.create({
      data: {
        id: holdId,
        tenant_id: input.tenantId,
        credit_account_id: input.accountId,
        idempotency_key: input.idempotencyKey,
        requested_micros: input.requestedMicros,
        expires_at: input.expiresAt,
        feature_key: input.featureKey ?? null,
      },
    });
    for (const allocation of allocations)
      await client.billing_credit_hold_allocation.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenantId,
          credit_hold_id: holdId,
          credit_grant_id: allocation.grantId,
          held_micros: allocation.amount,
        },
      });
    await client.billing_credit_account.update({
      where: { id: input.accountId },
      data: {
        available_micros: { decrement: input.requestedMicros },
        held_micros: { increment: input.requestedMicros },
        generation: { increment: 1 },
        updated_at: new Date(),
      },
    });
    return { holdId, requestedMicros: input.requestedMicros };
  }

  async capture(input: CaptureCreditInput): Promise<HoldTerminalResult> {
    return this.#finishHold(input, "captured");
  }
  async release(input: ReleaseCreditInput): Promise<HoldTerminalResult> {
    return this.#finishHold({ ...input, actualMicros: 0n }, "released");
  }

  async #finishHold(
    input: CaptureCreditInput,
    terminal: "captured" | "released",
  ): Promise<HoldTerminalResult> {
    if (input.actualMicros < 0n)
      throw new TypeError("actualMicros must be non-negative");
    const client = this.transactions.requireActiveTransaction(
      input.tenantId,
      "write",
    );
    const located = await client.billing_credit_hold.findFirst({
      where: { id: input.holdId, tenant_id: input.tenantId },
    });
    if (!located)
      throw new CreditError(
        "CREDIT_HOLD_NOT_ACTIVE",
        "Credit hold was not found",
      );
    await client.$queryRaw`SELECT id FROM billing_credit_account WHERE id=${located.credit_account_id}::uuid AND tenant_id=${input.tenantId} FOR UPDATE`;
    await client.$queryRaw`SELECT g.id FROM billing_credit_grant g JOIN billing_credit_hold_allocation a ON a.credit_grant_id=g.id WHERE a.credit_hold_id=${input.holdId}::uuid ORDER BY g.id FOR UPDATE OF g`;
    const rows = await client.$queryRaw<
      Array<{
        id: string;
        credit_account_id: string;
        requested_micros: bigint;
        status: string;
        captured_micros: bigint;
        released_micros: bigint;
      }>
    >`SELECT id, credit_account_id, requested_micros, status, captured_micros, released_micros FROM billing_credit_hold WHERE id=${input.holdId}::uuid AND tenant_id=${input.tenantId} FOR UPDATE`;
    const hold = rows[0];
    if (!hold)
      throw new CreditError(
        "CREDIT_HOLD_NOT_ACTIVE",
        "Credit hold was not found",
      );
    if (hold.status !== "active") {
      if (
        hold.status === terminal &&
        hold.captured_micros === input.actualMicros
      ) {
        if (terminal === "captured" && input.actualMicros > 0n) {
          const journal = await client.billing_credit_journal.findFirst({
            where: {
              tenant_id: input.tenantId,
              credit_account_id: hold.credit_account_id,
              entry_kind: "debit",
              source_kind: "usage",
            },
          });
          if (!journal || journal.source_ref !== input.sourceRef)
            throw new CreditError(
              "CREDIT_IDEMPOTENCY_CONFLICT",
              "Capture source differs",
            );
        }
        return {
          holdId: hold.id,
          accountId: hold.credit_account_id,
          capturedMicros: hold.captured_micros,
          releasedMicros: hold.released_micros,
        };
      }
      throw new CreditError(
        "CREDIT_IDEMPOTENCY_CONFLICT",
        "Credit hold terminal payload differs",
      );
    }
    if (input.actualMicros > hold.requested_micros)
      throw new CreditError("CREDIT_INSUFFICIENT", "Capture exceeds hold");
    const allocations = await client.$queryRaw<
      Array<{ id: string; credit_grant_id: string; held_micros: bigint }>
    >`SELECT a.id, a.credit_grant_id, a.held_micros FROM billing_credit_hold_allocation a JOIN billing_credit_grant g ON g.id=a.credit_grant_id WHERE a.credit_hold_id=${hold.id}::uuid ORDER BY g.expires_at NULLS LAST, g.burn_priority, g.issued_at, g.id`;
    let captureLeft = input.actualMicros;
    for (const allocation of allocations) {
      const captured =
        allocation.held_micros < captureLeft
          ? allocation.held_micros
          : captureLeft;
      const released = allocation.held_micros - captured;
      await client.billing_credit_hold_allocation.update({
        where: { id: allocation.id },
        data: {
          captured_micros: captured,
          released_micros: released,
          updated_at: new Date(),
        },
      });
      if (captured > 0n)
        await client.billing_credit_grant.update({
          where: { id: allocation.credit_grant_id },
          data: {
            remaining_micros: { decrement: captured },
            updated_at: new Date(),
          },
        });
      captureLeft -= captured;
    }
    const released = hold.requested_micros - input.actualMicros;
    await client.billing_credit_hold.update({
      where: { id: hold.id },
      data: {
        status: terminal,
        captured_micros: input.actualMicros,
        released_micros: released,
        updated_at: new Date(),
      },
    });
    await client.billing_credit_account.update({
      where: { id: hold.credit_account_id },
      data: {
        held_micros: { decrement: hold.requested_micros },
        available_micros: { increment: released },
        generation: { increment: 1 },
        updated_at: new Date(),
      },
    });
    if (input.actualMicros > 0n)
      await client.billing_credit_journal.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenantId,
          credit_account_id: hold.credit_account_id,
          journal_seq: await this.#nextJournalSeq(
            input.tenantId,
            hold.credit_account_id,
          ),
          entry_kind: "debit",
          amount_micros: -input.actualMicros,
          source_kind: "usage",
          source_ref: input.sourceRef,
        },
      });
    return {
      holdId: hold.id,
      accountId: hold.credit_account_id,
      capturedMicros: input.actualMicros,
      releasedMicros: released,
    };
  }

  async #nextJournalSeq(tenantId: string, accountId: string): Promise<bigint> {
    const client = this.transactions.requireActiveTransaction(
      tenantId,
      "write",
    );
    const aggregate = await client.billing_credit_journal.aggregate({
      where: { tenant_id: tenantId, credit_account_id: accountId },
      _max: { journal_seq: true },
    });
    return (aggregate._max.journal_seq ?? 0n) + 1n;
  }

  async refreshGrantWindows(
    tenantId: string,
    accountId: string,
  ): Promise<void> {
    const client = this.transactions.requireActiveTransaction(
      tenantId,
      "write",
    );
    await client.$queryRaw`SELECT id FROM billing_credit_account WHERE id=${accountId}::uuid AND tenant_id=${tenantId} FOR UPDATE`;
    await client.$queryRaw`SELECT id FROM billing_credit_grant WHERE credit_account_id=${accountId}::uuid AND tenant_id=${tenantId} ORDER BY id FOR UPDATE`;
    const clock = await client.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const now = clock[0]?.now;
    if (!now) throw new Error("Database clock unavailable");
    const grants = await client.billing_credit_grant.findMany({
      where: { tenant_id: tenantId, credit_account_id: accountId },
      orderBy: { id: "asc" },
    });
    let availableDelta = 0n;
    for (const grant of grants) {
      if (
        grant.status === "pending" &&
        grant.effective_at <= now &&
        (grant.expires_at === null || grant.expires_at > now)
      ) {
        await client.billing_credit_grant.update({
          where: { id: grant.id },
          data: { status: "active", updated_at: now },
        });
        availableDelta += grant.remaining_micros;
      } else if (
        (grant.status === "active" || grant.status === "pending") &&
        grant.expires_at !== null &&
        grant.expires_at <= now
      ) {
        const allocations = await client.$queryRaw<
          Array<{ reserved: bigint }>
        >`SELECT COALESCE(SUM(a.held_micros-a.captured_micros-a.released_micros),0)::bigint AS reserved FROM billing_credit_hold_allocation a JOIN billing_credit_hold h ON h.id=a.credit_hold_id WHERE a.tenant_id=${tenantId} AND a.credit_grant_id=${grant.id}::uuid AND h.status='active'`;
        const reserved = allocations[0]?.reserved ?? 0n;
        const expiredAvailable =
          grant.status === "active" ? grant.remaining_micros - reserved : 0n;
        availableDelta -= expiredAvailable;
        await client.billing_credit_grant.update({
          where: { id: grant.id },
          data: {
            status: "expired",
            remaining_micros: reserved,
            updated_at: now,
          },
        });
        if (expiredAvailable > 0n)
          await client.billing_credit_journal.create({
            data: {
              id: randomUUID(),
              tenant_id: tenantId,
              credit_account_id: accountId,
              journal_seq: await this.#nextJournalSeq(tenantId, accountId),
              entry_kind: "expiry",
              amount_micros: -expiredAvailable,
              source_kind: "grant_expiry",
              source_ref: grant.id,
            },
          });
      }
    }
    if (availableDelta !== 0n)
      await client.billing_credit_account.update({
        where: { id: accountId },
        data: {
          available_micros: { increment: availableDelta },
          generation: { increment: 1 },
          updated_at: now,
        },
      });
  }
  #positive(value: bigint): void {
    if (value <= 0n) throw new TypeError("amount must be positive");
  }
}
