import {
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CatalogGuard } from "../../http/catalog.guard.js";
import {
  BILLING_SCHEMA_VALIDATOR,
  type BillingSchemaValidator,
} from "../../infrastructure/auth/billing-auth.types.js";
import type { CatalogResponse } from "../../generated/billing-api/types.gen.js";
import { CatalogService } from "./catalog.service.js";
import { parseCatalogQuery } from "./catalog.query.js";

@Controller("v1/commerce")
@UseGuards(CatalogGuard)
export class CatalogReadController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(BILLING_SCHEMA_VALIDATOR)
    private readonly schemas: BillingSchemaValidator,
  ) {}
  @Get("catalog")
  async list(@Req() request: FastifyRequest): Promise<CatalogResponse> {
    const context = request.billingCatalogContext;
    if (!context) throw new InternalServerErrorException();
    const response = await this.catalog.list(
      context,
      parseCatalogQuery(request, context.tenantId),
    );
    this.schemas.assert("CatalogResponse", response);
    return response;
  }
}
