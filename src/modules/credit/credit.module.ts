import { Module } from "@nestjs/common";
import { AuditAppender } from "../../database/audit-appender.js";
import { CommandReceiptRepository } from "../../database/command-receipt.repository.js";
import { TransactionService } from "../../database/transaction.service.js";
import { CreditRepository } from "./credit.repository.js";
import { CreditEffects, CreditService } from "./credit.service.js";

@Module({
  providers: [
    {
      provide: CreditRepository,
      inject: [TransactionService],
      useFactory: (transactions: TransactionService) =>
        new CreditRepository(transactions),
    },
    {
      provide: CreditEffects,
      inject: [TransactionService, CreditRepository, AuditAppender],
      useFactory: (
        transactions: TransactionService,
        repository: CreditRepository,
        audit: AuditAppender,
      ) => new CreditEffects(transactions, repository, audit),
    },
    {
      provide: CreditService,
      inject: [TransactionService, CommandReceiptRepository, CreditEffects],
      useFactory: (
        transactions: TransactionService,
        receipts: CommandReceiptRepository,
        effects: CreditEffects,
      ) => new CreditService(transactions, receipts, effects),
    },
  ],
  exports: [CreditEffects, CreditService],
})
export class CreditModule {}
