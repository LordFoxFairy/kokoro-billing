import { describe, expect, it } from 'vitest';
import { allocateCreditGrants, InsufficientCreditError } from '../../src/modules/credit/allocate-grants.js';

describe('allocateCreditGrants', () => {
  it('burns earliest expiry, then priority, issue time and id', () => {
    const result = allocateCreditGrants([
      { grantId: 'late', availableMicros: 100, expiresAt: '2026-12-01T00:00:00.000Z', burnPriority: 1, issuedAt: '2026-01-01T00:00:00.000Z' },
      { grantId: 'early', availableMicros: 40, expiresAt: '2026-02-01T00:00:00.000Z', burnPriority: 99, issuedAt: '2026-01-02T00:00:00.000Z' },
      { grantId: 'priority', availableMicros: 50, expiresAt: '2026-12-01T00:00:00.000Z', burnPriority: 0, issuedAt: '2026-01-03T00:00:00.000Z' },
    ], 70);

    expect(result).toEqual([
      { grantId: 'early', amountMicros: 40 },
      { grantId: 'priority', amountMicros: 30 },
    ]);
  });

  it('rejects when available grants cannot cover the requested amount', () => {
    expect(() => allocateCreditGrants([
      { grantId: 'only', availableMicros: 9, expiresAt: null, burnPriority: 0, issuedAt: '2026-01-01T00:00:00.000Z' },
    ], 10)).toThrow(InsufficientCreditError);
  });

  it('uses stable id as the final tie breaker', () => {
    const result = allocateCreditGrants([
      { grantId: 'b', availableMicros: 5, expiresAt: null, burnPriority: 0, issuedAt: '2026-01-01T00:00:00.000Z' },
      { grantId: 'a', availableMicros: 5, expiresAt: null, burnPriority: 0, issuedAt: '2026-01-01T00:00:00.000Z' },
    ], 6);

    expect(result).toEqual([{ grantId: 'a', amountMicros: 5 }, { grantId: 'b', amountMicros: 1 }]);
  });
});
