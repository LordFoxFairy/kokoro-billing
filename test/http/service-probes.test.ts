import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  ServiceProbesController,
  type BillingReadiness,
} from "../../src/http/service-probes.controller.js";

const reply = () => {
  const status = vi.fn<FastifyReply["status"]>();
  return { response: { status } as unknown as FastifyReply, status };
};

describe("Billing service probes", () => {
  it("keeps liveness independent from PostgreSQL", () => {
    const pingForReadiness = vi.fn<BillingReadiness["pingForReadiness"]>();
    const controller = new ServiceProbesController({ pingForReadiness });
    expect(controller.health()).toEqual({ data: { status: "ok" } });
    expect(pingForReadiness).not.toHaveBeenCalled();
  });

  it("reports only the installed PostgreSQL dependency when its bounded ping succeeds", async () => {
    const pingForReadiness = vi
      .fn<BillingReadiness["pingForReadiness"]>()
      .mockResolvedValue(undefined);
    const controller = new ServiceProbesController({ pingForReadiness });
    const { response, status } = reply();
    await expect(controller.ready(response)).resolves.toEqual({
      data: { status: "ready", dependencies: { postgres: "ok" } },
    });
    expect(status).not.toHaveBeenCalled();
    expect(pingForReadiness).toHaveBeenCalledOnce();
  });

  it("returns stable not-ready data without leaking the PostgreSQL failure", async () => {
    const pingForReadiness = vi
      .fn<BillingReadiness["pingForReadiness"]>()
      .mockRejectedValue(new Error("private database detail"));
    const controller = new ServiceProbesController({ pingForReadiness });
    const { response, status } = reply();
    await expect(controller.ready(response)).resolves.toEqual({
      data: {
        status: "not_ready",
        dependencies: { postgres: "unavailable" },
      },
    });
    expect(status).toHaveBeenCalledWith(503);
  });
});
