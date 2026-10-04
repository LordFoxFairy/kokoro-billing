import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { IamBillingAuthorizationClient } from "../../src/modules/metering/iam-billing-authorization.client.js";
import { resolveIamBillingAuthorizationOptions } from "../../src/modules/metering/iam-billing-authorization.options.js";

type Reply = Readonly<{
  status?: number;
  body?: unknown;
  delayMs?: number;
}>;

const machineToken = "machine-secret-canary";
const userToken = "user-secret-canary";
const future = "2099-01-01T00:00:00.000Z";
const allowed = (overrides: Record<string, unknown> = {}) => ({
  data: {
    allowed: true,
    tenant_id: "tenant-a",
    user_id: "user-a",
    session_id: "session-a",
    client_id: "client-a",
    expires_at: future,
    decision_ref: "decision-a",
    ...overrides,
  },
});

async function peer(reply: Reply): Promise<{
  server: Server;
  baseUrl: string;
  requests: Array<
    Readonly<{
      headers: IncomingHttpHeaders;
      body: unknown;
    }>
  >;
}> {
  const requests: Array<{
    headers: IncomingHttpHeaders;
    body: unknown;
  }> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const respond = async () => {
        requests.push({
          headers: request.headers,
          body: JSON.parse(raw) as unknown,
        });
        if (reply.delayMs !== undefined)
          await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        response.writeHead(reply.status ?? 200, {
          "content-type": "application/json",
          "x-request-id": "iam-owner-request",
        });
        response.end(JSON.stringify(reply.body ?? allowed()));
      };
      void respond().catch(() => response.destroy());
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("loopback peer has no address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

const input = (
  subject: "user" | "project" | "organization" | "service" = "user",
  ref = subject === "user" ? "user-a" : `${subject}-a`,
  signal = new AbortController().signal,
) => ({
  tenantId: "tenant-a",
  billingSubject: { kind: subject, ref },
  consumptionToken: userToken,
  requestId: "billing-request-a",
  signal,
});

describe("IAM Billing authorization through the published SDK HTTP transport", () => {
  const servers: Server[] = [];
  const clients: IamBillingAuthorizationClient[] = [];
  afterEach(async () => {
    await Promise.all(
      clients.splice(0).map((client) => client.onModuleDestroy()),
    );
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
  });
  const setup = async (reply: Reply, deadlineMs = 250) => {
    const fixture = await peer(reply);
    servers.push(fixture.server);
    const client = new IamBillingAuthorizationClient(
      resolveIamBillingAuthorizationOptions({
        baseUrl: fixture.baseUrl,
        machineBearerToken: machineToken,
        deadlineMs,
      }),
    );
    clients.push(client);
    return { ...fixture, client };
  };

  it.each(["user", "project", "organization", "service"] as const)(
    "binds %s attribution to the IAM user payer with exactly one request",
    async (kind) => {
      const fixture = await setup({ body: allowed() });
      await expect(fixture.client.authorize(input(kind))).resolves.toEqual({
        payerUserId: "user-a",
      });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({
        headers: {
          authorization: `Bearer ${machineToken}`,
          "x-request-id": "billing-request-a",
        },
        body: { access_token: userToken, action: "credit.consume" },
      });
    },
  );

  it.each(["2099-01-01T00:00:00Z", "2099-01-01T00:00:00.123456Z"])(
    "accepts the IAM contract UTC precision %s",
    async (expiresAt) => {
      const fixture = await setup({ body: allowed({ expires_at: expiresAt }) });
      await expect(fixture.client.authorize(input())).resolves.toEqual({
        payerUserId: "user-a",
      });
      expect(fixture.requests).toHaveLength(1);
    },
  );

  it.each([
    ["tenant mismatch", allowed({ tenant_id: "tenant-b" }), "BINDING_MISMATCH"],
    ["user mismatch", allowed(), "BINDING_MISMATCH"],
    [
      "expired at arrival",
      allowed({ expires_at: "2020-01-01T00:00:00.000Z" }),
      "EXPIRED",
    ],
    ["malformed expiry", allowed({ expires_at: "2099-01-01" }), "UNAVAILABLE"],
  ] as const)("rejects %s without retrying", async (name, body, code) => {
    const fixture = await setup({ body });
    await expect(
      fixture.client.authorize(
        name === "user mismatch" ? input("user", "other-user") : input(),
      ),
    ).rejects.toMatchObject({ code });
    expect(fixture.requests).toHaveLength(1);
  });

  it.each([
    [400, "INVALID_ARGUMENT", "AUTHORIZATION_INVALID"],
    [401, "UNAUTHENTICATED", "DENIED"],
    [403, "PERMISSION_DENIED", "DENIED"],
    [409, "CONFLICT", "DENIED"],
    [429, "RATE_LIMITED", "UNAVAILABLE"],
    [503, "DEPENDENCY_UNAVAILABLE", "UNAVAILABLE"],
  ] as const)(
    "maps IAM HTTP %i without retry",
    async (status, ownerCode, code) => {
      const fixture = await setup({
        status,
        body: {
          error: {
            code: ownerCode,
            message: `${machineToken}:${userToken}`,
            retryable: status >= 429,
            details: [],
          },
        },
      });
      let thrown: unknown;
      try {
        await fixture.client.authorize(input());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code });
      expect(String(thrown)).not.toContain(machineToken);
      expect(String(thrown)).not.toContain(userToken);
      expect(fixture.requests).toHaveLength(1);
    },
  );

  it("bounds timeout and caller abort to one physical request", async () => {
    const timeout = await setup({ body: allowed(), delayMs: 100 }, 20);
    await expect(timeout.client.authorize(input())).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(timeout.requests).toHaveLength(1);

    const aborted = await setup({ body: allowed(), delayMs: 100 });
    const controller = new AbortController();
    const pending = aborted.client.authorize(
      input("user", "user-a", controller.signal),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(aborted.requests.length).toBeLessThanOrEqual(1);
  });

  it("aborts inflight work on shutdown and rejects later calls", async () => {
    const fixture = await setup({ body: allowed(), delayMs: 100 });
    const pending = fixture.client.authorize(input());
    await fixture.client.onModuleDestroy();
    await expect(pending).rejects.toMatchObject({ code: "SHUTTING_DOWN" });
    await expect(fixture.client.authorize(input())).rejects.toMatchObject({
      code: "SHUTTING_DOWN",
    });
    expect(fixture.requests.length).toBeLessThanOrEqual(1);
  });
});
