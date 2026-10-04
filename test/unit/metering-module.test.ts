import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AuditAppender } from "../../src/database/audit-appender.js";
import { CommandReceiptRepository } from "../../src/database/command-receipt.repository.js";
import { DatabaseModule } from "../../src/database/database.module.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { TransactionService } from "../../src/database/transaction.service.js";
import { CreditEffects } from "../../src/modules/credit/credit.service.js";
import { IamBillingAuthorizationClient } from "../../src/modules/metering/iam-billing-authorization.client.js";
import { MeteringModule } from "../../src/modules/metering/metering.module.js";
import { MeteringRepository } from "../../src/modules/metering/metering.repository.js";
import { MeteringService } from "../../src/modules/metering/metering.service.js";

describe("Metering module IAM authorization registration", () => {
  it("adds the authorizer without removing static quote and settlement providers", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.register({
          databaseUrl: "postgresql://unused.invalid/r201_never_connected",
        }),
        MeteringModule.register({
          baseUrl: "http://127.0.0.1:1",
          machineBearerToken: "machine-secret-canary",
          deadlineMs: 25,
        }),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(TransactionService)
      .useValue({})
      .overrideProvider(CommandReceiptRepository)
      .useValue({})
      .overrideProvider(AuditAppender)
      .useValue({})
      .overrideProvider(CreditEffects)
      .useValue({})
      .compile();
    try {
      expect(moduleRef.get(MeteringRepository)).toBeInstanceOf(
        MeteringRepository,
      );
      expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService);
      expect(moduleRef.get(IamBillingAuthorizationClient)).toBeInstanceOf(
        IamBillingAuthorizationClient,
      );
    } finally {
      await moduleRef.close();
    }
  });

  it("keeps the original static module usable without IAM configuration", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.register({
          databaseUrl: "postgresql://unused.invalid/r201_never_connected",
        }),
        MeteringModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(TransactionService)
      .useValue({})
      .overrideProvider(CommandReceiptRepository)
      .useValue({})
      .overrideProvider(AuditAppender)
      .useValue({})
      .overrideProvider(CreditEffects)
      .useValue({})
      .compile();
    try {
      expect(moduleRef.get(MeteringService)).toBeInstanceOf(MeteringService);
      expect(() => moduleRef.get(IamBillingAuthorizationClient)).toThrow();
    } finally {
      await moduleRef.close();
    }
  });
});
