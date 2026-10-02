import {
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { BILLING_SCHEMA_VALIDATOR } from "../../infrastructure/auth/billing-auth.types.js";
import type {
  BillingSchemaValidator,
  BillingUserContext,
} from "../../infrastructure/auth/billing-auth.types.js";
import type {
  CreditAccountResponse,
  CreditLedgerResponse,
} from "../../generated/billing-api/types.gen.js";
import { PersonalGuard } from "../../http/personal.guard.js";
import { CreditService } from "./credit.service.js";
import { mapCreditAccount, mapCreditLedger } from "./credit-read.mapper.js";
import {
  assertCreditAccountQuery,
  parseCreditLedgerQuery,
} from "./credit-read.query.js";

@Controller("v2/billing/me")
@UseGuards(PersonalGuard)
export class CreditReadController {
  constructor(
    @Inject(CreditService) private readonly credit: CreditService,
    @Inject(BILLING_SCHEMA_VALIDATOR)
    private readonly schemas: BillingSchemaValidator,
  ) {}
  private context(request: FastifyRequest): BillingUserContext {
    if (request.billingPersonalContext === undefined)
      throw new InternalServerErrorException();
    return request.billingPersonalContext;
  }
  @Get("credit-account")
  async account(
    @Req() request: FastifyRequest,
  ): Promise<CreditAccountResponse> {
    assertCreditAccountQuery(request);
    const account = await this.credit.getMyAccount(this.context(request));
    if (account === null) throw new NotFoundException();
    const response = mapCreditAccount(account);
    this.schemas.assert("CreditAccountResponse", response);
    return response;
  }
  @Get("credit-ledger")
  async ledger(@Req() request: FastifyRequest): Promise<CreditLedgerResponse> {
    const query = parseCreditLedgerQuery(request);
    const response = mapCreditLedger(
      await this.credit.listMyLedger(this.context(request), query),
    );
    this.schemas.assert("CreditLedgerResponse", response);
    return response;
  }
}
