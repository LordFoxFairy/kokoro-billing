import type { RecordReversalInput, ReversalResult, ReverseCreditsInput } from '../commands/billing-reversal-service.js';

export interface BillingReversalRepository {
  recordReversal(input: RecordReversalInput): Promise<string>;
  reverseCredits(input: ReverseCreditsInput): Promise<ReversalResult>;
}
