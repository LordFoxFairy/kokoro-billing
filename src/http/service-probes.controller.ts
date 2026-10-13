import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

export const BILLING_READINESS = Symbol("BILLING_READINESS");
export type BillingReadiness = Readonly<{ pingForReadiness(): Promise<void> }>;
type ReadyResponse = Readonly<{
  data: {
    status: "ready" | "not_ready";
    dependencies: { postgres: "ok" | "unavailable" };
  };
}>;

@Controller()
export class ServiceProbesController {
  constructor(
    @Inject(BILLING_READINESS) private readonly readiness: BillingReadiness,
  ) {}

  @Get("healthz")
  health(): Readonly<{ data: { status: "ok" } }> {
    return { data: { status: "ok" } };
  }

  @Get("readyz")
  async ready(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReadyResponse> {
    try {
      await this.readiness.pingForReadiness();
      return {
        data: { status: "ready", dependencies: { postgres: "ok" } },
      };
    } catch {
      reply.status(503);
      return {
        data: {
          status: "not_ready",
          dependencies: { postgres: "unavailable" },
        },
      };
    }
  }
}
