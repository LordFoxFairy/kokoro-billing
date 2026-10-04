import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { TransactionService } from "../../database/transaction.service.js";
import { CreditModule } from "../credit/credit.public.js";
import { CreditEffects } from "../credit/credit.public.js";
import { MeteringRepository } from "./metering.repository.js";
import { MeteringService } from "./metering.service.js";
import { IamBillingAuthorizationClient } from "./iam-billing-authorization.client.js";
import {
  IAM_BILLING_AUTHORIZATION_OPTIONS,
  resolveIamBillingAuthorizationOptions,
  type IamBillingAuthorizationOptions,
  type ResolvedIamBillingAuthorizationOptions,
} from "./iam-billing-authorization.options.js";

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
export class MeteringModule {
  static register(options: IamBillingAuthorizationOptions): DynamicModule {
    const resolved = resolveIamBillingAuthorizationOptions(options);
    return {
      module: MeteringModule,
      providers: [
        {
          provide: IAM_BILLING_AUTHORIZATION_OPTIONS,
          useValue: resolved,
        },
        {
          provide: IamBillingAuthorizationClient,
          inject: [IAM_BILLING_AUTHORIZATION_OPTIONS],
          useFactory: (value: ResolvedIamBillingAuthorizationOptions) =>
            new IamBillingAuthorizationClient(value),
        },
      ],
      exports: [IamBillingAuthorizationClient],
    };
  }
}
