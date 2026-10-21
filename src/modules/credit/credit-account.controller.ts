import {
  Controller,
  Inject,
  InternalServerErrorException,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CreditAccountGuard } from "../../http/credit-account.guard.js";
import { BILLING_SCHEMA_VALIDATOR } from "../../infrastructure/auth/billing-auth.types.js";
import type { BillingSchemaValidator } from "../../infrastructure/auth/billing-auth.types.js";
import type { CreditAccountResponse } from "../../generated/billing-api/types.gen.js";
import { CreditService } from "./credit.service.js";
import { mapCreditAccount } from "./credit-read.mapper.js";
import { assertOpenCreditAccountInput } from "./credit-account.input.js";
@Controller("v1/billing/me")
@UseGuards(CreditAccountGuard)
export class CreditAccountController {
  constructor(
    @Inject(CreditService) private readonly credit: CreditService,
    @Inject(BILLING_SCHEMA_VALIDATOR)
    private readonly schemas: BillingSchemaValidator,
  ) {}
  @Put("credit-account")
  async open(@Req() request: FastifyRequest): Promise<CreditAccountResponse> {
    assertOpenCreditAccountInput(request);
    if (request.billingPersonalContext === undefined)
      throw new InternalServerErrorException();
    const result = mapCreditAccount(
      await this.credit.openMyAccount(request.billingPersonalContext),
    );
    this.schemas.assert("CreditAccountResponse", result);
    return result;
  }
}
