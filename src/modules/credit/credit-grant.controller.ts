import { Controller, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { BillingOperatorGuard } from "../../http/billing-operator.guard.js";
import { BILLING_SCHEMA_VALIDATOR } from "../../infrastructure/auth/billing-auth.types.js";
import type { BillingSchemaValidator } from "../../infrastructure/auth/billing-auth.types.js";
import type { AdminCreditGrantResponse } from "../../generated/billing-api/types.gen.js";
import { CreditService } from "./credit.service.js";
import { readAdminCreditGrantInput } from "./credit-grant.input.js";

@Controller("v1/admin/billing/credit-grants")
@UseGuards(BillingOperatorGuard)
export class CreditGrantController {
  constructor(
    @Inject(CreditService) private readonly credit: CreditService,
    @Inject(BILLING_SCHEMA_VALIDATOR)
    private readonly schemas: BillingSchemaValidator,
  ) {}
  @Post()
  async create(
    @Req() request: FastifyRequest,
  ): Promise<AdminCreditGrantResponse> {
    const grant = await this.credit.grant(
      readAdminCreditGrantInput(request, this.schemas),
    );
    const result = {
      data: {
        account_id: grant.accountId,
        grant_id: grant.grantId,
        journal_id: grant.journalId,
      },
    };
    this.schemas.assert("AdminCreditGrantResponse", result);
    return result;
  }
}
