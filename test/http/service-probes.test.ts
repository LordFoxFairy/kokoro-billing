import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ServiceProbesController } from "../../src/http/service-probes.controller.js";
import type { BillingPgReadiness } from "../../src/http/service-probes.options.js";

const reply = () => {
  const status = vi.fn<FastifyReply["status"]>();
  return { response: { status } as unknown as FastifyReply, status };
};

describe("Billing service probes", () => {
  it("keeps liveness independent from PostgreSQL", () => {
    const ping = vi.fn<BillingPgReadiness["ping"]>();
    const controller = new ServiceProbesController({ ping });
    expect(controller.health()).toEqual({ data: { status: "ok" } });
    expect(ping).not.toHaveBeenCalled();
  });

  it("reports only the installed PostgreSQL dependency when its bounded ping succeeds", async () => {
    const ping = vi
      .fn<BillingPgReadiness["ping"]>()
      .mockResolvedValue(undefined);
    const controller = new ServiceProbesController({ ping });
    const { response, status } = reply();
    await expect(controller.ready(response)).resolves.toEqual({
      data: { status: "ready", dependencies: { postgres: "ok" } },
    });
    expect(status).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledOnce();
  });

  it("returns stable not-ready data without leaking the PostgreSQL failure", async () => {
    const ping = vi
      .fn<BillingPgReadiness["ping"]>()
      .mockRejectedValue(new Error("private database detail"));
    const controller = new ServiceProbesController({ ping });
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
