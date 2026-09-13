import { Module, type DynamicModule } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import type { PrismaServiceOptions } from "./prisma.types.js";
import { TransactionService } from "./transaction.service.js";

export const PRISMA_SERVICE_OPTIONS = Symbol("PRISMA_SERVICE_OPTIONS");

@Module({})
export class DatabaseModule {
  static register(options: PrismaServiceOptions): DynamicModule {
    return {
      module: DatabaseModule,
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
      ],
      exports: [TransactionService],
    };
  }
}
