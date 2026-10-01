import { randomUUID } from "node:crypto";
import type { TransactionService } from "../../database/transaction.service.js";
import type { TransactionClient } from "../../database/transaction.types.js";
import { CreditError } from "./credit.error.js";
import type {
  CaptureCreditInput,
  CreditAccountSnapshot,
  GrantCreditEffectInput,
  GrantCreditResult,
  HoldTerminalMutationResult,
  ReleaseCreditInput,
  ReserveCreditEffectInput,
  ReserveCreditResult,
} from "./credit.types.js";

type PersistedCreditHold = Awaited<
  ReturnType<TransactionClient["billing_credit_hold"]["findMany"]>
>[number];
type PersistedCreditHoldAllocation = Awaited<
  ReturnType<TransactionClient["billing_credit_hold_allocation"]["findMany"]>
>[number];
type PersistedCreditGrant = Awaited<
  ReturnType<TransactionClient["billing_credit_grant"]["findMany"]>
>[number];

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

  async capture(
    input: CaptureCreditInput,
  ): Promise<HoldTerminalMutationResult> {
    return this.#finishHold(input, "captured");
  }
  async release(
    input: ReleaseCreditInput,
  ): Promise<HoldTerminalMutationResult> {
    return this.#finishHold({ ...input, actualMicros: 0n }, "released");
  }

  async #finishHold(
    input: CaptureCreditInput,
    terminal: "captured" | "released",
  ): Promise<HoldTerminalMutationResult> {
    if (input.actualMicros < 0n)
      throw new TypeError("actualMicros must be non-negative");
    if (!this.#validTerminalSource(input.sourceRef))
      throw new TypeError(
        "sourceRef must contain 1..255 valid Unicode code points",
      );
    const client = this.transactions.requireActiveTransaction(
      input.tenantId,
      "write",
    );
    // The initial location supplies only the account lock key, never authority.
    const located = await client.billing_credit_hold.findFirst({
      where: { id: input.holdId, tenant_id: input.tenantId },
      select: { credit_account_id: true },
    });
    if (!located)
      throw new CreditError(
        "CREDIT_HOLD_NOT_ACTIVE",
        "Credit hold was not found",
      );
    const lockedAccount = await client.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM billing_credit_account WHERE id=${located.credit_account_id}::uuid AND tenant_id=${input.tenantId} FOR UPDATE`;
    if (lockedAccount.length !== 1)
      this.#terminalCorrupt("Hold account relationship is invalid");
    await client.$queryRaw`SELECT id FROM billing_credit_grant WHERE credit_account_id=${located.credit_account_id}::uuid AND tenant_id=${input.tenantId} ORDER BY id FOR UPDATE`;
    await client.$queryRaw`SELECT id FROM billing_credit_hold WHERE id=${input.holdId}::uuid AND tenant_id=${input.tenantId} FOR UPDATE`;
    const hold = await client.billing_credit_hold.findFirst({
      where: { id: input.holdId, tenant_id: input.tenantId },
    });
    if (!hold)
      throw new CreditError(
        "CREDIT_HOLD_NOT_ACTIVE",
        "Credit hold was not found",
      );
    if (hold.credit_account_id !== located.credit_account_id)
      this.#terminalCorrupt("Hold account changed outside its lock boundary");
    const account = await client.billing_credit_account.findFirst({
      where: { id: hold.credit_account_id, tenant_id: input.tenantId },
    });
    if (!account || account.available_micros < 0n || account.held_micros < 0n)
      this.#terminalCorrupt("Hold account projection is invalid");
    const grants = await client.billing_credit_grant.findMany({
      where: { tenant_id: input.tenantId, credit_account_id: account.id },
      orderBy: { id: "asc" },
    });
    await client.$queryRaw`SELECT id FROM billing_credit_hold_allocation WHERE credit_hold_id=${hold.id}::uuid AND tenant_id=${input.tenantId} ORDER BY id FOR UPDATE`;
    const allocations = await client.billing_credit_hold_allocation.findMany({
      where: { credit_hold_id: hold.id, tenant_id: input.tenantId },
      orderBy: { id: "asc" },
    });
    // This integrity count is bounded by the already locked, tenant-owned parent.
    // A mismatched child tenant must not disappear behind the valid-row filter.
    const referenceCount = await client.billing_credit_hold_allocation.count({
      where: { credit_hold_id: hold.id },
    });
    if (referenceCount !== allocations.length)
      this.#terminalCorrupt("Hold allocation tenant relationship is invalid");
    this.#assertTerminalHold(hold);
    this.#assertTerminalAllocations(hold, allocations, grants);
    if (hold.status !== "active") {
      const terminalSource = hold.terminal_source_ref;
      if (terminalSource === null)
        this.#terminalCorrupt("Terminal hold source is missing");
      if (hold.status === "captured" && hold.captured_micros > 0n) {
        const journals = await client.billing_credit_journal.findMany({
          where: {
            tenant_id: input.tenantId,
            entry_kind: "debit",
            source_kind: "usage",
            source_ref: terminalSource,
          },
        });
        const journal = journals[0];
        if (
          journals.length !== 1 ||
          !journal ||
          journal.credit_account_id !== hold.credit_account_id ||
          journal.amount_micros !== -hold.captured_micros
        )
          this.#terminalCorrupt(
            "Captured hold must have exactly one matching debit",
          );
      }
      if (
        hold.status !== terminal ||
        terminalSource !== input.sourceRef ||
        hold.captured_micros !== input.actualMicros
      )
        throw new CreditError(
          "CREDIT_IDEMPOTENCY_CONFLICT",
          "Credit hold terminal payload differs",
        );
      return {
        applied: false,
        value: {
          holdId: hold.id,
          accountId: hold.credit_account_id,
          capturedMicros: hold.captured_micros,
          releasedMicros: hold.released_micros,
        },
      };
    }
    if (input.actualMicros > hold.requested_micros)
      throw new CreditError("CREDIT_INSUFFICIENT", "Capture exceeds hold");
    if (account.held_micros < hold.requested_micros)
      this.#terminalCorrupt("Account no longer covers the active hold");
    if (terminal === "captured") {
      const priorSource = await client.billing_credit_hold.findFirst({
        where: {
          tenant_id: input.tenantId,
          status: "captured",
          terminal_source_ref: input.sourceRef,
        },
        select: { id: true },
      });
      if (priorSource)
        throw new CreditError(
          "CREDIT_IDEMPOTENCY_CONFLICT",
          "Capture source belongs to another hold",
        );
    }
    const clock = await client.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const now = clock[0]?.now;
    if (!now) this.#terminalCorrupt("Database clock unavailable");
    const released = hold.requested_micros - input.actualMicros;
    const transition = await client.billing_credit_hold.updateMany({
      where: {
        id: hold.id,
        tenant_id: input.tenantId,
        credit_account_id: account.id,
        status: "active",
        terminal_source_ref: null,
        captured_micros: 0n,
        released_micros: 0n,
      },
      data: {
        status: terminal,
        terminal_source_ref: input.sourceRef,
        captured_micros: input.actualMicros,
        released_micros: released,
        updated_at: now,
      },
    });
    if (transition.count !== 1)
      this.#terminalCorrupt("Hold transition lost its active identity");
    // Grant locks use UUID order; consumption independently uses expiry/burn/issued/id.
    const grantById = new Map(grants.map((grant) => [grant.id, grant]));
    allocations.sort((left, right) => {
      const a = grantById.get(left.credit_grant_id);
      const b = grantById.get(right.credit_grant_id);
      if (!a || !b) this.#terminalCorrupt("Allocation grant is missing");
      const aExpiry = a.expires_at?.getTime() ?? Infinity;
      const bExpiry = b.expires_at?.getTime() ?? Infinity;
      if (aExpiry !== bExpiry) return aExpiry - bExpiry;
      if (a.burn_priority !== b.burn_priority)
        return a.burn_priority - b.burn_priority;
      if (a.issued_at.getTime() !== b.issued_at.getTime())
        return a.issued_at.getTime() - b.issued_at.getTime();
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    let captureLeft = input.actualMicros;
    for (const allocation of allocations) {
      const captured =
        allocation.held_micros < captureLeft
          ? allocation.held_micros
          : captureLeft;
      const allocationReleased = allocation.held_micros - captured;
      const allocated = await client.billing_credit_hold_allocation.updateMany({
        where: {
          id: allocation.id,
          tenant_id: input.tenantId,
          credit_hold_id: hold.id,
          credit_grant_id: allocation.credit_grant_id,
          held_micros: allocation.held_micros,
          captured_micros: 0n,
          released_micros: 0n,
        },
        data: {
          captured_micros: captured,
          released_micros: allocationReleased,
          updated_at: now,
        },
      });
      if (allocated.count !== 1)
        this.#terminalCorrupt("Active hold allocation changed");
      if (captured > 0n) {
        const debited = await client.billing_credit_grant.updateMany({
          where: {
            id: allocation.credit_grant_id,
            tenant_id: input.tenantId,
            credit_account_id: account.id,
            remaining_micros: { gte: captured },
          },
          data: { remaining_micros: { decrement: captured }, updated_at: now },
        });
        if (debited.count !== 1)
          this.#terminalCorrupt("Allocated grant no longer covers capture");
      }
      captureLeft -= captured;
    }
    if (captureLeft !== 0n)
      this.#terminalCorrupt("Capture amount is not covered by allocations");
    const projected = await client.billing_credit_account.updateMany({
      where: {
        id: account.id,
        tenant_id: input.tenantId,
        generation: account.generation,
        held_micros: { gte: hold.requested_micros },
      },
      data: {
        held_micros: { decrement: hold.requested_micros },
        available_micros: { increment: released },
        generation: { increment: 1 },
        updated_at: now,
      },
    });
    if (projected.count !== 1)
      this.#terminalCorrupt(
        "Account projection changed during hold completion",
      );
    if (input.actualMicros > 0n)
      await client.billing_credit_journal.create({
        data: {
          id: randomUUID(),
          tenant_id: input.tenantId,
          credit_account_id: account.id,
          journal_seq: await this.#nextJournalSeq(input.tenantId, account.id),
          entry_kind: "debit",
          amount_micros: -input.actualMicros,
          source_kind: "usage",
          source_ref: input.sourceRef,
        },
      });
    return {
      applied: true,
      value: {
        holdId: hold.id,
        accountId: account.id,
        capturedMicros: input.actualMicros,
        releasedMicros: released,
      },
    };
  }

  #validTerminalSource(value: string): boolean {
    if (typeof value !== "string") return false;
    let length = 0;
    for (const character of value) {
      const point = character.codePointAt(0);
      if (
        point === undefined ||
        point === 0 ||
        (point >= 0xd800 && point <= 0xdfff)
      )
        return false;
      length += 1;
      if (length > 255) return false;
    }
    return length > 0;
  }

  #assertTerminalHold(hold: PersistedCreditHold): void {
    if (
      hold.requested_micros < 0n ||
      hold.captured_micros < 0n ||
      hold.released_micros < 0n
    )
      this.#terminalCorrupt("Hold amounts are invalid");
    if (hold.status === "active") {
      if (
        hold.terminal_source_ref !== null ||
        hold.captured_micros !== 0n ||
        hold.released_micros !== 0n
      )
        this.#terminalCorrupt("Active hold contains terminal facts");
      return;
    }
    if (
      !["captured", "released", "expired"].includes(hold.status) ||
      hold.terminal_source_ref === null ||
      !this.#validTerminalSource(hold.terminal_source_ref) ||
      hold.captured_micros + hold.released_micros !== hold.requested_micros ||
      (hold.status !== "captured" && hold.captured_micros !== 0n)
    )
      this.#terminalCorrupt("Hold terminal identity or amounts are incomplete");
  }

  #assertTerminalAllocations(
    hold: PersistedCreditHold,
    allocations: readonly PersistedCreditHoldAllocation[],
    grants: readonly PersistedCreditGrant[],
  ): void {
    const grantById = new Map(grants.map((grant) => [grant.id, grant]));
    let held = 0n;
    let captured = 0n;
    let released = 0n;
    for (const allocation of allocations) {
      const grant = grantById.get(allocation.credit_grant_id);
      if (
        !grant ||
        grant.tenant_id !== hold.tenant_id ||
        grant.credit_account_id !== hold.credit_account_id ||
        grant.original_micros < 0n ||
        grant.remaining_micros < 0n ||
        grant.remaining_micros > grant.original_micros ||
        allocation.tenant_id !== hold.tenant_id ||
        allocation.credit_hold_id !== hold.id ||
        allocation.held_micros < 0n ||
        allocation.captured_micros < 0n ||
        allocation.released_micros < 0n ||
        allocation.captured_micros + allocation.released_micros >
          allocation.held_micros ||
        (hold.status === "active" &&
          (allocation.captured_micros !== 0n ||
            allocation.released_micros !== 0n ||
            grant.remaining_micros < allocation.held_micros)) ||
        (hold.status !== "active" &&
          allocation.captured_micros + allocation.released_micros !==
            allocation.held_micros)
      )
        this.#terminalCorrupt(
          "Hold allocation relationship or amounts are invalid",
        );
      held += allocation.held_micros;
      captured += allocation.captured_micros;
      released += allocation.released_micros;
    }
    if (
      held !== hold.requested_micros ||
      captured !== hold.captured_micros ||
      released !== hold.released_micros
    )
      this.#terminalCorrupt("Hold and allocation amounts do not reconcile");
  }

  #terminalCorrupt(message: string): never {
    throw new CreditError("CREDIT_HOLD_TERMINAL_CORRUPT", message);
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
