import { MeteringPricingReadService } from "./metering-pricing-read.service.js";
import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { TransactionService } from "../../database/transaction.service.js";
import { AuditAppender } from "../../database/audit-appender.js";
import { CommandReceiptRepository } from "../../database/command-receipt.repository.js";
import { CreditModule } from "../credit/credit.public.js";
import { CreditEffects } from "../credit/credit.public.js";
import { MeteringRepository } from "./metering.repository.js";
import { MeteringService } from "./metering.service.js";
import { MeteringPricingPublicationService } from "./metering-pricing-publication.service.js";
import { MeteringPricingRevisionRepository } from "./metering-pricing-revision.repository.js";
import { MeteringPricingSelectionService } from "./metering-pricing-selection.service.js";
import { IamBillingAuthorizationClient } from "./iam-billing-authorization.client.js";
import { ModelAdmissionService } from "./model-admission.service.js";
import { AgentUsageEvidenceReader } from "./agent-usage-evidence-reader.js";
import {
  resolveModelAdmissionOptions,
  type ModelAdmissionOptions,
} from "./model-admission.options.js";

@Module({
  imports: [CreditModule],
  providers: [
    {
      provide: MeteringPricingReadService,
      inject: [TransactionService, MeteringPricingRevisionRepository],
      useFactory: (
        transactions: TransactionService,
        repository: MeteringPricingRevisionRepository,
      ) => new MeteringPricingReadService(transactions, repository),
    },
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
    {
      provide: MeteringPricingRevisionRepository,
      inject: [TransactionService],
      useFactory: (transactions: TransactionService) =>
        new MeteringPricingRevisionRepository(transactions),
    },
    {
      provide: MeteringPricingPublicationService,
      inject: [
        TransactionService,
        CommandReceiptRepository,
        AuditAppender,
        MeteringPricingRevisionRepository,
      ],
      useFactory: (
        transactions: TransactionService,
        receipts: CommandReceiptRepository,
        audit: AuditAppender,
        repository: MeteringPricingRevisionRepository,
      ) =>
        new MeteringPricingPublicationService(
          transactions,
          receipts,
          audit,
          repository,
        ),
    },
    {
      provide: MeteringPricingSelectionService,
      inject: [MeteringPricingRevisionRepository],
      useFactory: (repository: MeteringPricingRevisionRepository) =>
        new MeteringPricingSelectionService(repository),
    },
  ],
  exports: [
    MeteringService,
    MeteringPricingPublicationService,
    MeteringPricingReadService,
  ],
})
export class MeteringModule {
  static registerModelAdmission(options: ModelAdmissionOptions): DynamicModule {
    const resolved = resolveModelAdmissionOptions(options);
    return {
      module: MeteringModule,
      providers: [
        {
          provide: AgentUsageEvidenceReader,
          useFactory: () => new AgentUsageEvidenceReader(resolved.agent),
        },
        {
          provide: IamBillingAuthorizationClient,
          useFactory: () => new IamBillingAuthorizationClient(resolved.iam),
        },
        {
          provide: ModelAdmissionService,
          inject: [
            TransactionService,
            CommandReceiptRepository,
            AuditAppender,
            CreditEffects,
            MeteringPricingSelectionService,
            AgentUsageEvidenceReader,
            IamBillingAuthorizationClient,
          ],
          useFactory: (
            tx: TransactionService,
            receipts: CommandReceiptRepository,
            audit: AuditAppender,
            credit: CreditEffects,
            pricing: MeteringPricingSelectionService,
            agent: AgentUsageEvidenceReader,
            iam: IamBillingAuthorizationClient,
          ) =>
            new ModelAdmissionService(
              tx,
              receipts,
              audit,
              credit,
              pricing,
              agent,
              iam,
            ),
        },
      ],
      exports: [ModelAdmissionService],
    };
  }
}
