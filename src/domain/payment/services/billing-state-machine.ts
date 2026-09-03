export type PaymentCollectionStatus = 'open' | 'requires_action' | 'authorized' | 'captured' | 'partially_refunded' | 'refunded' | 'failed' | 'cancelled' | 'unknown';
export type PaymentAttemptStatus = 'created' | 'authorization_pending' | 'authorized' | 'capture_pending' | 'captured' | 'voided' | 'failed' | 'unknown';
export type AdmissionStatus = 'created' | 'held' | 'captured' | 'released' | 'unknown' | 'rejected';

const transitions = {
  paymentCollection: {
    open: ['requires_action', 'authorized', 'failed', 'cancelled', 'unknown'],
    requires_action: ['authorized', 'failed', 'cancelled', 'unknown'],
    authorized: ['captured', 'failed', 'cancelled', 'unknown'],
    captured: ['partially_refunded', 'refunded', 'unknown'],
    partially_refunded: ['refunded', 'unknown'],
    refunded: [], failed: [], cancelled: [], unknown: ['authorized', 'captured', 'failed', 'cancelled', 'unknown'],
  } satisfies Record<PaymentCollectionStatus, readonly PaymentCollectionStatus[]>,
  paymentAttempt: {
    created: ['authorization_pending', 'failed', 'voided', 'unknown'],
    authorization_pending: ['authorized', 'failed', 'voided', 'unknown'],
    authorized: ['capture_pending', 'voided', 'unknown'],
    capture_pending: ['captured', 'failed', 'unknown'],
    captured: [], voided: [], failed: [], unknown: ['authorized', 'capture_pending', 'captured', 'failed', 'voided', 'unknown'],
  } satisfies Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]>,
  admission: {
    created: ['held', 'rejected', 'unknown'], held: ['captured', 'released', 'unknown'],
    captured: [], released: [], unknown: ['captured', 'released', 'unknown'], rejected: [],
  } satisfies Record<AdmissionStatus, readonly AdmissionStatus[]>,
} as const;

export function canTransition<K extends keyof typeof transitions>(kind: K, from: keyof typeof transitions[K], to: string): boolean {
  return (transitions[kind][from] as readonly string[]).includes(to);
}

export function assertTransition<K extends keyof typeof transitions>(kind: K, from: keyof typeof transitions[K], to: string): void {
  if (!canTransition(kind, from, to)) throw new Error(`billing.invalid_${String(kind)}_transition`);
}
