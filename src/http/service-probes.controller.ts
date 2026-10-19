import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  BILLING_PG_READINESS,
  type BillingPgReadiness,
} from "./service-probes.options.js";
import { collectBillingMetrics } from "../infrastructure/metrics.js";

@Controller()
export class ServiceProbesController {
  constructor(
    @Inject(BILLING_PG_READINESS) private readonly database: BillingPgReadiness,
  ) {}
  @Get("healthz")
  health() {
    return { data: { status: "ok" } };
  }
  @Get("readyz")
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    try {
      await this.database.ping();
    } catch {
      reply.status(503);
      return {
        data: {
          status: "not_ready",
          dependencies: { postgres: "unavailable" },
        },
      };
    }
    return {
      data: {
        status: "ready",
        dependencies: { postgres: "ok" },
      },
    };
  }
  @Get("metrics")
  async metrics(@Res() reply: FastifyReply) {
    const metrics = await collectBillingMetrics();
    return reply.header("content-type", metrics.contentType).send(metrics.body);
  }
}
