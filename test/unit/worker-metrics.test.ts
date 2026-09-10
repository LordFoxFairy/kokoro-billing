import { afterEach, describe, expect, it } from "vitest";
import {
  recordWorkerResult,
  startWorkerMetricsServer,
} from "../../src/infrastructure/worker-metrics.js";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("worker metrics", () => {
  it("serves Prometheus worker counters over HTTP", async () => {
    server = await startWorkerMetricsServer(0);
    recordWorkerResult("dead_lettered");
    const response = await server.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("billing_worker_results_total");
    expect(response.body).toContain('result="dead_lettered"');
  });
});
