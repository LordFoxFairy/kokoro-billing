import { randomUUID } from 'node:crypto';
import type { Connection, ResultSetHeader, RowDataPacket } from '../../application/ports.js';
import { allocateCreditGrants, type CreditGrantForAllocation } from '../credit/allocate-grants.js';
import { readSafeInteger } from '../../infrastructure/postgres/safe-integer.js';

export type UsageEventInput = {
  readonly usageEventId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly sourceEventId: string;
  readonly featureKey: string;
  readonly quantityMicros: number;
  readonly dimensions?: Record<string, unknown>;
};

export type AuthorizeUsageInput = {
  readonly tenantId: string;
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly requestedMicros: number;
  readonly featureKey: string;
  readonly labelKey?: string | null;
  readonly modelBindingId?: string | null;
  readonly pricingRevisionId?: string | null;
  readonly ttlSeconds?: number;
};

export type UsageHold = {
  readonly holdId: string;
  readonly allocations: readonly { readonly grantId: string; readonly amountMicros: number }[];
};

export type SettleUsageInput = {
  readonly tenantId: string;
  readonly holdId: string;
  readonly usageEventId: string;
  readonly idempotencyKey: string;
  readonly actualMicros: number;
};

export type UsageSettlementResult = {
  readonly settlementId: string;
  readonly capturedMicros: number;
  readonly releasedMicros: number;
};

export type UsageReleaseResult = { readonly holdId: string; readonly releasedMicros: number };
export type UsageExpiryResult = { readonly expiredHoldIds: readonly string[] };

export class UsageSettlementService {
  public constructor(private readonly connection: Connection) {}

  public async recordUsageEvent(input: UsageEventInput): Promise<void> {
    if (!Number.isSafeInteger(input.quantityMicros) || input.quantityMicros < 0) throw new RangeError('quantityMicros must be a non-negative safe integer');
    const [sourceRows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT usage_event_id FROM entitlement_usage_event WHERE tenant_id = $1 AND source_event_id = $2`,
      [input.tenantId, input.sourceEventId],
    );
    if (sourceRows[0] && String((sourceRows[0] as { usage_event_id: string }).usage_event_id) !== input.usageEventId) throw new Error('billing.idempotency_conflict');
    await this.connection.execute(
      `INSERT INTO entitlement_usage_event
        (usage_event_id, tenant_id, subject_id, source_event_id, feature_key, quantity_micros, dimensions_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'recorded')
       ON CONFLICT DO NOTHING`,
      [input.usageEventId, input.tenantId, input.subjectId, input.sourceEventId, input.featureKey, input.quantityMicros, input.dimensions === undefined ? null : JSON.stringify(input.dimensions)],
    );
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT usage_event_id, tenant_id, subject_id, source_event_id, feature_key, quantity_micros, dimensions_json
         FROM entitlement_usage_event WHERE tenant_id = $1 AND source_event_id = $2`,
      [input.tenantId, input.sourceEventId],
    );
    const row = rows[0] as { usage_event_id: string; tenant_id: string; subject_id: string; source_event_id: string; feature_key: string; quantity_micros: string | number; dimensions_json: Record<string, unknown> | string | null } | undefined;
    if (!row) {
      const [eventRows] = await this.connection.execute<RowDataPacket[]>('SELECT usage_event_id FROM entitlement_usage_event WHERE tenant_id = $1 AND usage_event_id = $2', [input.tenantId, input.usageEventId]);
      if (eventRows[0]) throw new Error('billing.idempotency_conflict');
      throw new Error('billing.usage_event_not_found');
    }
    const storedDimensions = row.dimensions_json === null ? undefined : typeof row.dimensions_json === 'string' ? JSON.parse(row.dimensions_json) as Record<string, unknown> : row.dimensions_json;
    if (row.tenant_id !== input.tenantId || row.subject_id !== input.subjectId || row.source_event_id !== input.sourceEventId || row.feature_key !== input.featureKey || String(row.quantity_micros) !== String(input.quantityMicros) || stableJson(storedDimensions) !== stableJson(input.dimensions)) {
      throw new Error('billing.idempotency_conflict');
    }
  }

  public async ensureUsageEventForHold(input: { tenantId: string; holdId: string; sourceEventId: string }): Promise<string> {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT h.credit_account_id, h.feature_key, a.subject_id
         FROM entitlement_credit_hold h
         INNER JOIN entitlement_credit_account a ON a.credit_account_id = h.credit_account_id AND a.tenant_id = h.tenant_id
        WHERE h.credit_hold_id = $1 AND h.tenant_id = $2`,
      [input.holdId, input.tenantId],
    );
    const row = rows[0] as { credit_account_id: string; feature_key: string; subject_id: string } | undefined;
    if (!row) throw new Error('billing.credit_hold_not_found');
    const usageEventId = `hold:${input.holdId}`;
    await this.recordUsageEvent({ usageEventId, tenantId: input.tenantId, subjectId: row.subject_id, sourceEventId: input.sourceEventId, featureKey: row.feature_key, quantityMicros: 0 });
    return usageEventId;
  }

  public async authorizeUsage(input: AuthorizeUsageInput): Promise<UsageHold> {
    if (!Number.isSafeInteger(input.requestedMicros) || input.requestedMicros <= 0) throw new RangeError('requestedMicros must be positive');
    await this.connection.beginTransaction();
    try {
      const [prior] = await this.connection.execute<RowDataPacket[]>(
        `SELECT credit_hold_id, credit_account_id, requested_micros, feature_key, label_key, model_binding_id, pricing_revision_id
           FROM entitlement_credit_hold WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.tenantId, input.idempotencyKey],
      );
      if (prior[0]) {
        const row = prior[0] as { credit_hold_id: string; credit_account_id: string; requested_micros: string | number; feature_key: string | null; label_key: string | null; model_binding_id: string | null; pricing_revision_id: string | null };
        const sameNullable = (left: string | null, right: string | null | undefined): boolean => left === (right ?? null);
        if (row.credit_account_id !== input.accountId
          || readSafeInteger(row.requested_micros, 'requested_micros') !== input.requestedMicros
          || row.feature_key !== input.featureKey
          || !sameNullable(row.label_key, input.labelKey)
          || !sameNullable(row.model_binding_id, input.modelBindingId)
          || !sameNullable(row.pricing_revision_id, input.pricingRevisionId)) throw new Error('billing.idempotency_conflict');
        const holdId = row.credit_hold_id;
        const [allocations] = await this.connection.execute<RowDataPacket[]>(
          `SELECT credit_grant_id, held_micros FROM entitlement_credit_hold_allocation WHERE tenant_id = $1 AND credit_hold_id = $2 ORDER BY credit_grant_id`,
          [input.tenantId, holdId],
        );
        await this.connection.commit();
        return { holdId, allocations: allocations.map((row) => ({ grantId: String(row.credit_grant_id), amountMicros: readSafeInteger(row.held_micros, 'held_micros') })) };
      }

      const [accounts] = await this.connection.execute<RowDataPacket[]>(
        `SELECT credit_account_id FROM entitlement_credit_account WHERE credit_account_id = $1 AND tenant_id = $2 AND status = 'active' FOR UPDATE`,
        [input.accountId, input.tenantId],
      );
      if (!accounts[0]) throw new Error('billing.credit_account_not_found');

      const [rows] = await this.connection.execute<RowDataPacket[]>(
        `SELECT g.credit_grant_id, g.remaining_micros,
                g.expires_at, g.burn_priority, g.issued_at,
                g.remaining_micros - COALESCE((
                  SELECT SUM(a.held_micros - a.captured_micros - a.released_micros)
                    FROM entitlement_credit_hold_allocation a
                    JOIN entitlement_credit_hold h ON h.credit_hold_id = a.credit_hold_id
                   WHERE a.tenant_id = g.tenant_id AND a.credit_grant_id = g.credit_grant_id AND h.status = 'active'
                ), 0) AS available_micros
           FROM entitlement_credit_grant g
          WHERE g.tenant_id = $1 AND g.credit_account_id = $2 AND g.status = 'active'
            AND g.effective_at <= CURRENT_TIMESTAMP(6)
            AND (g.expires_at IS NULL OR g.expires_at > CURRENT_TIMESTAMP(6))
          ORDER BY (g.expires_at IS NULL), g.expires_at, g.burn_priority, g.issued_at, g.credit_grant_id
          FOR UPDATE`,
        [input.tenantId, input.accountId],
      );
      const grants: CreditGrantForAllocation[] = rows
        .map((row) => ({
          grantId: String(row.credit_grant_id),
          availableMicros: readSafeInteger(row.available_micros, 'available_micros'),
          expiresAt: row.expires_at === null ? null : new Date(row.expires_at as string | Date).toISOString(),
          burnPriority: Number(row.burn_priority),
          issuedAt: new Date(row.issued_at as string | Date).toISOString(),
        }))
        .filter((grant) => grant.availableMicros > 0);
      const allocations = allocateCreditGrants(grants, input.requestedMicros);
      const holdId = randomUUID();
      const ttlSeconds = input.ttlSeconds ?? 300;
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) throw new RangeError('ttlSeconds must be an integer between 1 and 3600');
      await this.connection.execute(
        `INSERT INTO entitlement_credit_hold
          (credit_hold_id, tenant_id, credit_account_id, idempotency_key, requested_micros, expires_at, feature_key, label_key, model_binding_id, pricing_revision_id)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP(6) + ($6 * INTERVAL '1 second'), $7, $8, $9, $10)`,
        [holdId, input.tenantId, input.accountId, input.idempotencyKey, input.requestedMicros, ttlSeconds, input.featureKey, input.labelKey ?? null, input.modelBindingId ?? null, input.pricingRevisionId ?? null],
      );
      for (const allocation of allocations) {
        await this.connection.execute(
          `INSERT INTO entitlement_credit_hold_allocation (credit_hold_id, tenant_id, credit_grant_id, held_micros)
           VALUES ($1, $2, $3, $4)`,
          [holdId, input.tenantId, allocation.grantId, allocation.amountMicros],
        );
      }
      const [accountUpdate] = await this.connection.execute<ResultSetHeader>(
        `UPDATE entitlement_credit_account
            SET available_micros = available_micros - $1, held_micros = held_micros + $2, generation = generation + 1
          WHERE tenant_id = $3 AND credit_account_id = $4 AND available_micros >= $5`,
        [input.requestedMicros, input.requestedMicros, input.tenantId, input.accountId, input.requestedMicros],
      );
      if (accountUpdate.affectedRows !== 1) throw new Error('billing.credit_projection_drift');
      await this.connection.commit();
      return { holdId, allocations };
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  public async settleUsage(input: SettleUsageInput): Promise<UsageSettlementResult> {
    if (!Number.isSafeInteger(input.actualMicros) || input.actualMicros < 0) throw new RangeError('actualMicros must be non-negative');
    await this.connection.beginTransaction();
    try {
      const [prior] = await this.connection.execute<RowDataPacket[]>(
        `SELECT s.usage_settlement_id, s.tenant_id, s.usage_event_id, s.actual_micros, h.requested_micros
           FROM entitlement_usage_settlement s
           JOIN entitlement_credit_hold h ON h.credit_hold_id = s.credit_hold_id
          WHERE s.tenant_id = $1 AND s.credit_hold_id = $2 FOR UPDATE`,
        [input.tenantId, input.holdId],
      );
      if (prior[0]) {
        const row = prior[0] as { usage_settlement_id: string; tenant_id: string; usage_event_id: string; actual_micros: string | number; requested_micros: string | number };
        const actualMicros = readSafeInteger(row.actual_micros, 'actual_micros');
        const requestedMicros = readSafeInteger(row.requested_micros, 'requested_micros');
        if (row.tenant_id !== input.tenantId || row.usage_event_id !== input.usageEventId || actualMicros !== input.actualMicros) {
          throw new Error('billing.idempotency_conflict');
        }
        await this.connection.commit();
        return { settlementId: row.usage_settlement_id, capturedMicros: actualMicros, releasedMicros: requestedMicros - actualMicros };
      }

      const [holds] = await this.connection.execute<RowDataPacket[]>(
        `SELECT h.credit_account_id, h.requested_micros, h.status, h.feature_key,
                a.subject_id
           FROM entitlement_credit_hold h
           INNER JOIN entitlement_credit_account a ON a.credit_account_id = h.credit_account_id AND a.tenant_id = h.tenant_id
          WHERE h.credit_hold_id = $1 AND h.tenant_id = $2 FOR UPDATE`,
        [input.holdId, input.tenantId],
      );
      const hold = holds[0] as { credit_account_id: string; requested_micros: number; status: string; feature_key: string; subject_id: string } | undefined;
      if (!hold) throw new Error('billing.credit_hold_not_found');
      if (hold.status !== 'active') throw new Error('billing.credit_hold_not_active');
      const requestedMicros = readSafeInteger(hold.requested_micros, 'requested_micros');
      if (input.actualMicros > requestedMicros) throw new Error('billing.usage_exceeds_hold');

      const [events] = await this.connection.execute<RowDataPacket[]>(
        `SELECT usage_event_id, status, subject_id, feature_key FROM entitlement_usage_event WHERE usage_event_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.usageEventId, input.tenantId],
      );
      const event = events[0] as { usage_event_id: string; status: string; subject_id: string; feature_key: string } | undefined;
      if (!event) throw new Error('billing.usage_event_not_found');
      if (event.status !== 'recorded') throw new Error('billing.usage_event_not_recorded');
      if (event.subject_id !== hold.subject_id || event.feature_key !== hold.feature_key) throw new Error('billing.usage_event_mismatch');

      const [allocations] = await this.connection.execute<RowDataPacket[]>(
        `SELECT credit_grant_id, held_micros FROM entitlement_credit_hold_allocation WHERE tenant_id = $1 AND credit_hold_id = $2 ORDER BY credit_grant_id FOR UPDATE`,
        [input.tenantId, input.holdId],
      );
      let remainingCapture = input.actualMicros;
      let releasedMicros = 0;
      for (const row of allocations) {
        const held = readSafeInteger(row.held_micros, 'held_micros');
        const captured = Math.min(held, remainingCapture);
        const released = held - captured;
        remainingCapture -= captured;
        releasedMicros += released;
        if (captured > 0) {
          const [grantUpdate] = await this.connection.execute<ResultSetHeader>(
            `UPDATE entitlement_credit_grant SET status = CASE WHEN remaining_micros = $1 THEN 'exhausted' ELSE status END, remaining_micros = remaining_micros - $2 WHERE tenant_id = $3 AND credit_grant_id = $4 AND remaining_micros >= $5`,
            [captured, captured, input.tenantId, row.credit_grant_id, captured],
          );
          if (grantUpdate.affectedRows !== 1) throw new Error('billing.usage_allocation_drift');
        }
        await this.connection.execute(
          `UPDATE entitlement_credit_hold_allocation SET captured_micros = $1, released_micros = $2 WHERE tenant_id = $3 AND credit_hold_id = $4 AND credit_grant_id = $5`,
          [captured, released, input.tenantId, input.holdId, row.credit_grant_id],
        );
      }
      if (remainingCapture !== 0) throw new Error('billing.usage_allocation_drift');

      const [sequences] = await this.connection.execute<RowDataPacket[]>(
        `SELECT COALESCE(MAX(journal_seq), 0) AS journal_seq FROM entitlement_credit_journal WHERE tenant_id = $1 AND credit_account_id = $2`,
        [input.tenantId, hold.credit_account_id],
      );
      const journalSeq = (BigInt(String((sequences[0] as { journal_seq: number | string }).journal_seq)) + 1n).toString();
      if (input.actualMicros > 0) {
        await this.connection.execute(
          `INSERT INTO entitlement_credit_journal
            (journal_id, tenant_id, credit_account_id, journal_seq, entry_kind, amount_micros, source_kind, source_ref)
           VALUES ($1, $2, $3, $4, 'debit', $5, 'usage_settlement', $6)`,
          [randomUUID(), input.tenantId, hold.credit_account_id, journalSeq, -input.actualMicros, input.holdId],
        );
      }
      const settlementId = randomUUID();
      await this.connection.execute(
        `INSERT INTO entitlement_usage_settlement
          (usage_settlement_id, tenant_id, credit_hold_id, usage_event_id, actual_micros, status)
         VALUES ($1, $2, $3, $4, $5, 'settled')`,
        [settlementId, input.tenantId, input.holdId, input.usageEventId, input.actualMicros],
      );
      await this.connection.execute(
        `UPDATE entitlement_credit_hold SET status = 'captured', captured_micros = $1, released_micros = $2 WHERE tenant_id = $3 AND credit_hold_id = $4`,
        [input.actualMicros, releasedMicros, input.tenantId, input.holdId],
      );
      const [accountUpdate] = await this.connection.execute<ResultSetHeader>(
        `UPDATE entitlement_credit_account
            SET available_micros = available_micros + $1, held_micros = held_micros - $2, generation = generation + 1
          WHERE tenant_id = $3 AND credit_account_id = $4 AND held_micros >= $5`,
        [releasedMicros, requestedMicros, input.tenantId, hold.credit_account_id, requestedMicros],
      );
      if (accountUpdate.affectedRows !== 1) throw new Error('billing.credit_projection_drift');
      await this.connection.execute(
        `UPDATE entitlement_usage_event SET status = 'settled' WHERE tenant_id = $1 AND usage_event_id = $2`,
        [input.tenantId, input.usageEventId],
      );
      await this.connection.execute(
        `INSERT INTO entitlement_outbox
          (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'usage_settlement', $3, 'UsageSettled', $4)`,
        [randomUUID(), input.tenantId, settlementId, JSON.stringify({ holdId: input.holdId, usageEventId: input.usageEventId, actualMicros: input.actualMicros })],
      );
      await this.connection.commit();
      return { settlementId, capturedMicros: input.actualMicros, releasedMicros };
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  public async releaseUsage(input: { readonly tenantId: string; readonly holdId: string; readonly idempotencyKey: string }): Promise<UsageReleaseResult> {
    await this.connection.beginTransaction();
    try {
      const [holds] = await this.connection.execute<RowDataPacket[]>(
        `SELECT credit_account_id, requested_micros, status, released_micros
           FROM entitlement_credit_hold WHERE credit_hold_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.holdId, input.tenantId],
      );
      const hold = holds[0] as { credit_account_id: string; requested_micros: number; status: string; released_micros: number } | undefined;
      if (!hold) throw new Error('billing.credit_hold_not_found');
      if (hold.status === 'released') {
        await this.connection.commit();
        return { holdId: input.holdId, releasedMicros: readSafeInteger(hold.released_micros, 'released_micros') };
      }
      if (hold.status !== 'active') throw new Error('billing.credit_hold_not_active');
      const [allocations] = await this.connection.execute<RowDataPacket[]>(
        `SELECT credit_grant_id, held_micros, captured_micros, released_micros
           FROM entitlement_credit_hold_allocation WHERE tenant_id = $1 AND credit_hold_id = $2 FOR UPDATE`,
          [input.tenantId, input.holdId],
      );
      let releasedMicros = 0;
      for (const allocation of allocations) {
        const remainder = readSafeInteger(allocation.held_micros, 'held_micros') - readSafeInteger(allocation.captured_micros, 'captured_micros') - readSafeInteger(allocation.released_micros, 'released_micros');
        if (remainder <= 0) continue;
        releasedMicros += remainder;
        await this.connection.execute(
          `UPDATE entitlement_credit_hold_allocation SET released_micros = released_micros + $1
            WHERE tenant_id = $2 AND credit_hold_id = $3 AND credit_grant_id = $4`,
          [remainder, input.tenantId, input.holdId, allocation.credit_grant_id],
        );
      }
      await this.connection.execute(
        `UPDATE entitlement_credit_hold SET status = 'released', released_micros = requested_micros
          WHERE tenant_id = $1 AND credit_hold_id = $2 AND status = 'active'`,
        [input.tenantId, input.holdId],
      );
      const [accountUpdate] = await this.connection.execute<ResultSetHeader>(
        `UPDATE entitlement_credit_account
            SET available_micros = available_micros + $1, held_micros = held_micros - $2, generation = generation + 1
          WHERE tenant_id = $3 AND credit_account_id = $4 AND held_micros >= $5`,
        [readSafeInteger(hold.requested_micros, 'requested_micros'), readSafeInteger(hold.requested_micros, 'requested_micros'), input.tenantId, hold.credit_account_id, readSafeInteger(hold.requested_micros, 'requested_micros')],
      );
      if (accountUpdate.affectedRows !== 1) throw new Error('billing.credit_projection_drift');
      await this.connection.execute(
        `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ($1, $2, 'credit_hold', $3, 'UsageHoldReleased', $4)`,
        [randomUUID(), input.tenantId, input.holdId, JSON.stringify({ holdId: input.holdId, idempotencyKey: input.idempotencyKey, releasedMicros })],
      );
      await this.connection.commit();
      return { holdId: input.holdId, releasedMicros };
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  /**
   * Reclaims abandoned reservations. This is deliberately a PostgreSQL transaction,
   * not a Redis TTL callback: expiration must release allocations and the
   * account projection together, and must be recoverable after process death.
   */
  public async expireExpiredHolds(input: { readonly tenantId?: string; readonly limit?: number } = {}): Promise<UsageExpiryResult> {
    const requestedLimit = input.limit ?? 100;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) throw new RangeError('limit must be a positive safe integer');
    const limit = Math.min(requestedLimit, 500);
    const sitePredicate = input.tenantId === undefined ? '' : 'AND tenant_id = ?';
    const siteArgs = input.tenantId === undefined ? [limit] : [input.tenantId, limit];
    const [holds] = await this.connection.query<RowDataPacket[]>(
      `SELECT credit_hold_id, tenant_id, credit_account_id, requested_micros
         FROM entitlement_credit_hold
        WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP(6) ${sitePredicate}
        ORDER BY expires_at, credit_hold_id
        LIMIT $1`,
      siteArgs,
    );
    const expiredHoldIds: string[] = [];
    for (const row of holds) {
      await this.connection.beginTransaction();
      try {
        const holdId = String(row.credit_hold_id);
        const [lockedHolds] = await this.connection.execute<RowDataPacket[]>(
          `SELECT tenant_id, credit_account_id, requested_micros, status
             FROM entitlement_credit_hold WHERE tenant_id = $1 AND credit_hold_id = $2 FOR UPDATE`,
          [row.tenant_id, holdId],
        );
        const hold = lockedHolds[0] as { tenant_id: string; credit_account_id: string; requested_micros: string | number; status: string } | undefined;
        if (!hold || hold.status !== 'active') { await this.connection.rollback(); continue; }
        const [allocations] = await this.connection.execute<RowDataPacket[]>(
          `SELECT credit_grant_id, held_micros, captured_micros, released_micros
             FROM entitlement_credit_hold_allocation WHERE tenant_id = $1 AND credit_hold_id = $2 FOR UPDATE`,
            [hold.tenant_id, holdId],
        );
        for (const allocation of allocations) {
          const remainder = readSafeInteger(allocation.held_micros, 'held_micros') - readSafeInteger(allocation.captured_micros, 'captured_micros') - readSafeInteger(allocation.released_micros, 'released_micros');
          if (remainder <= 0) continue;
          await this.connection.execute(
            `UPDATE entitlement_credit_hold_allocation
                SET released_micros = released_micros + $1
              WHERE tenant_id = $2 AND credit_hold_id = $3 AND credit_grant_id = $4`,
            [remainder, hold.tenant_id, holdId, allocation.credit_grant_id],
          );
        }
        await this.connection.execute(
          `UPDATE entitlement_credit_hold SET status = 'expired', released_micros = requested_micros
            WHERE tenant_id = $1 AND credit_hold_id = $2 AND status = 'active'`,
          [hold.tenant_id, holdId],
        );
        const [accountUpdate] = await this.connection.execute<ResultSetHeader>(
          `UPDATE entitlement_credit_account
              SET available_micros = available_micros + $1, held_micros = held_micros - $2, generation = generation + 1
              WHERE tenant_id = $3 AND credit_account_id = $4 AND held_micros >= $5`,
          [readSafeInteger(hold.requested_micros, 'requested_micros'), readSafeInteger(hold.requested_micros, 'requested_micros'), hold.tenant_id, hold.credit_account_id, readSafeInteger(hold.requested_micros, 'requested_micros')],
        );
        if (accountUpdate.affectedRows !== 1) throw new Error('billing.credit_projection_drift');
        await this.connection.execute(
          `INSERT INTO entitlement_outbox (outbox_id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
           VALUES ($1, $2, 'credit_hold', $3, 'UsageHoldExpired', $4)`,
          [randomUUID(), hold.tenant_id, holdId, JSON.stringify({ holdId, reason: 'ttl_expired' })],
        );
        await this.connection.commit();
        expiredHoldIds.push(holdId);
      } catch (error) {
        await this.connection.rollback();
        throw error;
      }
    }
    return { expiredHoldIds };
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}
