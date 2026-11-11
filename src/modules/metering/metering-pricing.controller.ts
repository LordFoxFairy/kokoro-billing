import { Controller, Get, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { BillingOperatorGuard } from "../../http/billing-operator.guard.js";
import {
  BILLING_SCHEMA_VALIDATOR,
  type BillingSchemaValidator,
} from "../../infrastructure/auth/billing-auth.types.js";
import { MeteringPricingPublicationService } from "./metering-pricing-publication.service.js";
import { MeteringPricingReadService } from "./metering-pricing-read.service.js";
import {
  assertMeteringReadRequest,
  meteringAdminContext,
  readMeteringRateCommand,
  readMeteringPolicyCommand,
} from "./metering-pricing.input.js";
import {
  mapMeteringLatestPricing,
  mapMeteringPublication,
} from "./metering-pricing.mapper.js";

@Controller("v1/admin/billing/metering")
@UseGuards(BillingOperatorGuard)
export class MeteringPricingController {
  constructor(
    @Inject(MeteringPricingPublicationService)
    private readonly publication: MeteringPricingPublicationService,
    @Inject(MeteringPricingReadService)
    private readonly read: MeteringPricingReadService,
    @Inject(BILLING_SCHEMA_VALIDATOR)
    private readonly schemas: BillingSchemaValidator,
  ) {}
  @Get("pricing")
  async latest(@Req() request: FastifyRequest) {
    assertMeteringReadRequest(request);
    const response = mapMeteringLatestPricing(
      await this.read.readLatest(meteringAdminContext(request)),
    );
    this.schemas.assert("AdminMeteringPricingResponse", response);
    return response;
  }
  @Post("rate-revisions")
  async rate(@Req() request: FastifyRequest) {
    const command = readMeteringRateCommand(request, this.schemas);
    const response = mapMeteringPublication(
      await this.publication.publishRate(
        meteringAdminContext(request),
        command,
      ),
    );
    this.schemas.assert("MeteringPublicationResponse", response);
    return response;
  }
  @Post("policy-revisions")
  async policy(@Req() request: FastifyRequest) {
    const command = readMeteringPolicyCommand(request, this.schemas);
    const response = mapMeteringPublication(
      await this.publication.publishPolicy(
        meteringAdminContext(request),
        command,
      ),
    );
    this.schemas.assert("MeteringPublicationResponse", response);
    return response;
  }
}
