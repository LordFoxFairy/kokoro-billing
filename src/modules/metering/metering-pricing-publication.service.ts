import type { AuditAppender } from "../../database/audit-appender.js";
import { CommandReceiptError } from "../../database/command-receipt.error.js";
import type { CommandReceiptRepository } from "../../database/command-receipt.repository.js";
import type { TransactionService } from "../../database/transaction.service.js";
import type { BillingAdminContext } from "../../infrastructure/auth/billing-auth.types.js";
import {
  decodeMeteringPolicyRevisionDraft,
  encodeMeteringPolicyPublicationCommand,
  encodeMeteringPolicyRevisionDraft,
  decodeMeteringRateRevisionDraft,
  encodeMeteringRatePublicationCommand,
  encodeMeteringRateRevisionDraft,
} from "./metering-pricing-revision-codec.js";
import type {
  MeteringPolicyRevisionDraft,
  MeteringPublicationCommand,
  MeteringRateRevisionDraft,
} from "./metering-pricing-revision.types.js";
import { meteringPricingPublicationResultCodec } from "./metering-pricing-publication-result-codec.js";
import type { MeteringPricingPublicationResultV1 } from "./metering-pricing-publication-result-codec.js";
import type { MeteringPricingRevisionRepository } from "./metering-pricing-revision.repository.js";
import { assertExecutableMeteringPolicy } from "./metering-policy-artifact.js";
import { MeteringError } from "./metering.error.js";

export class MeteringPricingPublicationService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly receipts: CommandReceiptRepository,
    private readonly audit: AuditAppender,
    private readonly repository: MeteringPricingRevisionRepository,
  ) {}

  async publishRate(
    context: BillingAdminContext | null,
    command: MeteringPublicationCommand<MeteringRateRevisionDraft>,
  ): Promise<MeteringPricingPublicationResultV1> {
    if (
      context === null ||
      context.role !== "billing.admin" ||
      context.tenantId !== command.tenantId ||
      context.tenantId !== command.draft.tenantId ||
      context.operatorId !== command.actorId
    )
      throw new MeteringError(
        "METERING_PUBLICATION_FORBIDDEN",
        "Metering publication is forbidden",
      );
    let publication: ReturnType<typeof encodeMeteringRatePublicationCommand>;
    let draft: MeteringRateRevisionDraft;
    try {
      publication = encodeMeteringRatePublicationCommand(command);
      const encodedDraft = encodeMeteringRateRevisionDraft(command.draft);
      draft = decodeMeteringRateRevisionDraft(encodedDraft.canonicalJson);
    } catch {
      throw new MeteringError(
        "METERING_PUBLICATION_UNAVAILABLE",
        "Metering publication is unavailable",
      );
    }
    try {
      return await this.transactions.runRoot(
        {
          tenantId: context.tenantId,
          actorId: context.operatorId,
          operation: "metering.publish_rate_revision",
          mode: "write",
        },
        async () => {
          const execution = await this.receipts.execute(
            {
              tenantId: publication.tenantId,
              namespace: publication.namespace,
              commandName: publication.commandName,
              commandIdentity: publication.commandIdentity,
              idempotencyKey: publication.idempotencyKey,
              requestSchemaVersion: publication.requestSchemaVersion,
              payloadDigest: publication.payloadDigest,
            },
            meteringPricingPublicationResultCodec("rate"),
            async () => {
              const publicationEffect = await this.repository.publishRate(
                draft,
                publication.contentDigest,
              );
              const { result } = publicationEffect;
              await this.audit.append({
                tenantId: publication.tenantId,
                action: "metering.publish_rate_revision",
                resourceType: "metering_rate_revision",
                resourceId: publicationEffect.revisionId,
                reason: command.reason,
                payload: {
                  publicationIdentity: command.publicationIdentity,
                  revision: result.revision,
                  contentDigest: result.contentDigest,
                  rateCount: draft.rates.length,
                },
              });
              return result;
            },
          );
          await this.repository.assertRatePublication(execution.value, draft);
          return execution.value;
        },
      );
    } catch (error) {
      if (error instanceof MeteringError) throw error;
      if (error instanceof CommandReceiptError) {
        if (error.code === "COMMAND_IDEMPOTENCY_CONFLICT")
          throw new MeteringError(
            "METERING_PUBLICATION_CONFLICT",
            "Metering publication conflicts with an existing command",
          );
        if (error.code === "COMMAND_RECEIPT_CORRUPT")
          throw new MeteringError(
            "METERING_PUBLICATION_CORRUPT",
            "Metering publication is corrupt",
          );
      }
      throw new MeteringError(
        "METERING_PUBLICATION_UNAVAILABLE",
        "Metering publication is unavailable",
      );
    }
  }

  async publishPolicy(
    context: BillingAdminContext | null,
    command: MeteringPublicationCommand<MeteringPolicyRevisionDraft>,
  ): Promise<MeteringPricingPublicationResultV1<"policy">> {
    if (
      context === null ||
      context.role !== "billing.admin" ||
      context.tenantId !== command.tenantId ||
      context.tenantId !== command.draft.tenantId ||
      context.operatorId !== command.actorId
    )
      throw new MeteringError(
        "METERING_PUBLICATION_FORBIDDEN",
        "Metering publication is forbidden",
      );
    let publication: ReturnType<typeof encodeMeteringPolicyPublicationCommand>;
    let draft: MeteringPolicyRevisionDraft;
    try {
      publication = encodeMeteringPolicyPublicationCommand(command);
      const encodedDraft = encodeMeteringPolicyRevisionDraft(command.draft);
      draft = decodeMeteringPolicyRevisionDraft(encodedDraft.canonicalJson);
      assertExecutableMeteringPolicy(draft);
    } catch {
      throw new MeteringError(
        "METERING_PUBLICATION_UNAVAILABLE",
        "Metering publication is unavailable",
      );
    }
    try {
      return await this.transactions.runRoot(
        {
          tenantId: context.tenantId,
          actorId: context.operatorId,
          operation: "metering.publish_policy_revision",
          mode: "write",
        },
        async () => {
          const execution = await this.receipts.execute(
            {
              tenantId: publication.tenantId,
              namespace: publication.namespace,
              commandName: publication.commandName,
              commandIdentity: publication.commandIdentity,
              idempotencyKey: publication.idempotencyKey,
              requestSchemaVersion: publication.requestSchemaVersion,
              payloadDigest: publication.payloadDigest,
            },
            meteringPricingPublicationResultCodec("policy"),
            async () => {
              const publicationEffect = await this.repository.publishPolicy(
                draft,
                publication.contentDigest,
              );
              const { result } = publicationEffect;
              await this.audit.append({
                tenantId: publication.tenantId,
                action: "metering.publish_policy_revision",
                resourceType: "metering_policy_revision",
                resourceId: publicationEffect.revisionId,
                reason: command.reason,
                payload: {
                  publicationIdentity: command.publicationIdentity,
                  revision: result.revision,
                  contentDigest: result.contentDigest,
                },
              });
              return result;
            },
          );
          await this.repository.assertPolicyPublication(execution.value, draft);
          return execution.value;
        },
      );
    } catch (error) {
      if (error instanceof MeteringError) throw error;
      if (error instanceof CommandReceiptError) {
        if (error.code === "COMMAND_IDEMPOTENCY_CONFLICT")
          throw new MeteringError(
            "METERING_PUBLICATION_CONFLICT",
            "Metering publication conflicts with an existing command",
          );
        if (error.code === "COMMAND_RECEIPT_CORRUPT")
          throw new MeteringError(
            "METERING_POLICY_CORRUPT",
            "Metering publication is corrupt",
          );
      }
      throw new MeteringError(
        "METERING_PUBLICATION_UNAVAILABLE",
        "Metering publication is unavailable",
      );
    }
  }
}
