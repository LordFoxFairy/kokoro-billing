import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import {
  BILLING_PERSONAL_AUTH,
  BILLING_PERSONAL_HTTP_OPTIONS,
} from "../infrastructure/auth/billing-auth.types.js";
import type {
  BillingPersonalAuth,
  BillingPersonalHttpOptions,
} from "../infrastructure/auth/billing-auth.types.js";
import { billingHeaderCount } from "../infrastructure/auth/billing-identity-header.js";

/** BFF human-admin admission is separate from machine and operator capabilities. */
@Injectable()
export class CreditGrantGuard implements CanActivate {
  constructor(
    @Inject(BILLING_PERSONAL_AUTH) private readonly auth: BillingPersonalAuth,
    @Inject(BILLING_PERSONAL_HTTP_OPTIONS)
    private readonly options: BillingPersonalHttpOptions,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    for (const name of [
      "authorization",
      "x-kokoro-service",
      "x-kokoro-internal-secret",
      "x-kokoro-tenant-id",
      "x-kokoro-subject",
      "x-kokoro-proxy-secret",
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
    const proxy = Buffer.from(
      request.headers["x-kokoro-proxy-secret"] as string,
    );
    const expected = Buffer.from(this.options.operatorProxySecret);
    if (proxy.length !== expected.length || !timingSafeEqual(proxy, expected))
      throw new ForbiddenException();
    // Exact machine marker prevents personal-auth's direct-user fallback.
    const admitted = await this.auth.authenticate(request);
    if (!admitted.ok) throw new ForbiddenException();
    request.billingPersonalContext = admitted.context;
    return true;
  }
}
