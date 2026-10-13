import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { BILLING_CATALOG_AUTH } from "../infrastructure/auth/billing-auth.types.js";
import type { BillingCatalogAuth } from "../infrastructure/auth/billing-auth.types.js";

@Injectable()
export class CatalogGuard implements CanActivate {
  constructor(
    @Inject(BILLING_CATALOG_AUTH) private readonly auth: BillingCatalogAuth,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const result = await this.auth.authenticate(request);
    if (!result.ok) {
      switch (result.status) {
        case 400:
          throw new BadRequestException();
        case 401:
          throw new UnauthorizedException();
        case 403:
          throw new ForbiddenException();
      }
    }
    request.billingCatalogContext = result.context;
    return true;
  }
}
