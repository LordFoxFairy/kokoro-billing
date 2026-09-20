import { Module, type DynamicModule } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import type { PrismaServiceOptions } from "./prisma.types.js";
import { TransactionService } from "./transaction.service.js";
import { CommandReceiptRepository } from "./command-receipt.repository.js";
import { AuditAppender } from "./audit-appender.js";
import { OutboxRepository } from "./outbox.repository.js";

export const PRISMA_SERVICE_OPTIONS = Symbol("PRISMA_SERVICE_OPTIONS");

@Module({})
export class DatabaseModule {
  static register(options: PrismaServiceOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: PRISMA_SERVICE_OPTIONS,
          useValue: Object.freeze({ ...options }),
        },
        {
          provide: PrismaService,
          inject: [PRISMA_SERVICE_OPTIONS],
          useFactory: (resolved: PrismaServiceOptions) =>
            new PrismaService(resolved),
        },
        {
          provide: TransactionService,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) =>
            new TransactionService(
              prisma.clientForDatabaseInfrastructure(),
              {},
              prisma,
            ),
        },
        {
          provide: CommandReceiptRepository,
          inject: [TransactionService],
          useFactory: (transactions: TransactionService) =>
            new CommandReceiptRepository(transactions),
        },
        {
          provide: AuditAppender,
          inject: [TransactionService],
          useFactory: (transactions: TransactionService) =>
            new AuditAppender(transactions),
        },
        {
          provide: OutboxRepository,
          inject: [TransactionService, AuditAppender],
          useFactory: (
            transactions: TransactionService,
            audit: AuditAppender,
          ) => new OutboxRepository(transactions, audit),
        },
      ],
      exports: [
        TransactionService,
        CommandReceiptRepository,
        AuditAppender,
        OutboxRepository,
      ],
    };
  }
}
