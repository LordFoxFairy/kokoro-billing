import { Module } from "@nestjs/common";
import { TransactionService } from "../../database/transaction.service.js";
import { CreditModule } from "../credit/credit.public.js";
import { CreditEffects } from "../credit/credit.public.js";
import { MeteringRepository } from "./metering.repository.js";
import { MeteringService } from "./metering.service.js";

@Module({
  imports: [CreditModule],
  providers: [
    {
      provide: MeteringRepository,
      inject: [TransactionService],
      useFactory: (transactions: TransactionService) =>
        new MeteringRepository(transactions),
    },
    {
      provide: MeteringService,
      inject: [TransactionService, MeteringRepository, CreditEffects],
      useFactory: (
        transactions: TransactionService,
        repository: MeteringRepository,
        credit: CreditEffects,
      ) => new MeteringService(transactions, repository, credit),
    },
  ],
  exports: [MeteringService],
})
export class MeteringModule {}
