import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { BILLING_PERSONAL_AUTH } from "../infrastructure/auth/billing-auth.types.js";
import type { BillingPersonalAuth } from "../infrastructure/auth/billing-auth.types.js";
import { billingHeaderCount } from "../infrastructure/auth/billing-identity-header.js";
import { BadRequestException } from "@nestjs/common";

/** This command never selects the direct-user authentication branch. */
@Injectable()
export class CreditAccountGuard implements CanActivate {
  constructor(
    @Inject(BILLING_PERSONAL_AUTH) private readonly auth: BillingPersonalAuth,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    for (const name of [
      "authorization",
      "x-kokoro-service",
      "x-kokoro-internal-secret",
      "x-kokoro-tenant-id",
      "x-kokoro-subject",
    ]) {
      if (
        billingHeaderCount(request.raw.rawHeaders, name) !== 1 ||
        typeof request.headers[name] !== "string" ||
        request.headers[name].length === 0
      )
        throw new ForbiddenException();
    }
    if (request.headers["x-kokoro-service"] !== "web-bff")
      throw new ForbiddenException();
    // The exact service marker above forces createBillingPersonalAuth's machine
    // branch. Its constant-time token/secret checks cannot fall back to a user.
    const result = await this.auth.authenticate(request);
    if (!result.ok) {
      if (result.status === 400) throw new BadRequestException();
      throw new ForbiddenException();
    }
    request.billingPersonalContext = result.context;
    return true;
  }
}
