import type { FastifyInstance } from "fastify";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  register,
} from "prom-client";

// Keep the same platform integration used by Payment/Model. Metrics are a
// side-channel: scrape failures must never affect a billing request.
let defaultsStarted = false;
const httpRequestsTotal = new Counter({
  name: "billing_http_requests_total",
  help: "Total HTTP requests handled by Billing.",
  labelNames: ["method", "route", "status_code"] as const,
});
const httpRequestDurationSeconds = new Histogram({
  name: "billing_http_request_duration_seconds",
  help: "HTTP request duration in seconds for Billing.",
  labelNames: ["method", "route"] as const,
});

export function recordHttpRequest(input: {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
}): void {
  try {
    const labels = {
      method: input.method,
      route: input.route,
      status_code: String(input.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(
      { method: input.method, route: input.route },
      input.durationSeconds,
    );
  } catch {
    // Metrics are fail-open and must never alter request semantics.
  }
}

export function registerMetricsRoute(
  app: FastifyInstance,
  moduleName = "billing",
): void {
  if (!defaultsStarted) {
    defaultsStarted = true;
    register.setDefaultLabels({ module: moduleName });
    collectDefaultMetrics();
  }
  app.get("/metrics", async (_request, reply) => {
    try {
      return reply
        .code(200)
        .header("content-type", register.contentType)
        .send(await register.metrics());
    } catch {
      return reply
        .code(200)
        .header("content-type", "text/plain; version=0.0.4")
        .send("");
    }
  });
}
