import { Module } from "@nestjs/common";
import { TransactionService } from "../../database/transaction.service.js";
import { CatalogService } from "./catalog.service.js";
import { CatalogRepository } from "./catalog.repository.js";

@Module({
  providers: [
    {
      provide: CatalogRepository,
      inject: [TransactionService],
      useFactory: (transactions: TransactionService) =>
        new CatalogRepository(transactions),
    },
    {
      provide: CatalogService,
      inject: [TransactionService, CatalogRepository],
      useFactory: (
        transactions: TransactionService,
        repository: CatalogRepository,
      ) => new CatalogService(transactions, repository),
    },
  ],
  exports: [CatalogService],
})
export class CommerceModule {}
