import {
  Controller,
  Get,
  Inject,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
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
    return { data: { module: "kokoro-billing", status: "ok" } };
  }
  @Get("readyz")
  async ready() {
    try {
      await this.database.ping();
    } catch {
      throw new ServiceUnavailableException();
    }
    return {
      data: {
        module: "kokoro-billing",
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
