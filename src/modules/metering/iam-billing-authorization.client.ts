import { IamClient, IamClientError } from "@kokoro/iam-client";
import type { OnModuleDestroy } from "@nestjs/common";
import { IamBillingAuthorizationError } from "./iam-billing-authorization.error.js";
import type {
  AuthorizeIamBillingInput,
  IamBillingAuthorization,
  ResolvedIamBillingAuthorizationOptions,
} from "./iam-billing-authorization.options.js";

const isIdentity = (value: string, maximum = 255): boolean => {
  if (typeof value !== "string") return false;
  const characters = [...value];
  return (
    characters.length > 0 &&
    characters.length <= maximum &&
    characters.every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127 && (point < 0xd800 || point > 0xdfff);
    })
  );
};

const exactUtcInstant = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value))
    return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
};

export class IamBillingAuthorizationClient implements OnModuleDestroy {
  readonly #client: IamClient;
  readonly #deadlineMs: number;
  readonly #shutdown = new AbortController();
  readonly #inflight = new Set<Promise<unknown>>();
  #closing = false;

  public constructor(options: ResolvedIamBillingAuthorizationOptions) {
    this.#client = new IamClient({
      baseUrl: options.baseUrl,
      bearerToken: options.machineBearerToken,
      deadlineMs: options.deadlineMs,
      retryReads: 0,
    });
    this.#deadlineMs = options.deadlineMs;
  }

  public authorize(
    input: AuthorizeIamBillingInput,
  ): Promise<IamBillingAuthorization> {
    if (this.#closing)
      return Promise.reject(new IamBillingAuthorizationError("SHUTTING_DOWN"));
    if (!this.#validInput(input))
      return Promise.reject(
        new IamBillingAuthorizationError("AUTHORIZATION_INVALID"),
      );
    const request = this.#authorize(input);
    this.#inflight.add(request);
    void request.finally(() => this.#inflight.delete(request)).catch(() => {});
    return request;
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.#closing) {
      await Promise.allSettled([...this.#inflight]);
      return;
    }
    this.#closing = true;
    this.#shutdown.abort();
    await Promise.allSettled([...this.#inflight]);
  }

  async #authorize(
    input: AuthorizeIamBillingInput,
  ): Promise<IamBillingAuthorization> {
    const signal = AbortSignal.any([input.signal, this.#shutdown.signal]);
    try {
      const response = await this.#client.verifyBillingAuthorization(
        {
          executionProof: input.executionProof,
          expectedRequestBindingSha256: input.requestBindingSha256,
        },
        {
          requestId: input.requestId,
          deadlineMs: this.#deadlineMs,
          signal,
        },
      );
      const decision = response.body.data;
      if (
        decision.allowed !== true ||
        decision.tenant_id !== input.tenantId ||
        !isIdentity(decision.user_id) ||
        decision.user_id !== input.payerUserId ||
        decision.run_id !== input.runId ||
        decision.execution_session_id !== input.executionSessionId ||
        String(decision.lease_generation) !== input.leaseGeneration ||
        decision.request_binding_sha256 !== input.requestBindingSha256 ||
        !isIdentity(decision.decision_ref)
      )
        throw new IamBillingAuthorizationError("BINDING_MISMATCH");
      const expiry = exactUtcInstant(decision.expires_at);
      if (expiry === null || expiry <= Date.now())
        throw new IamBillingAuthorizationError("EXPIRED");
      return Object.freeze({
        payerUserId: decision.user_id,
        expiresAt: decision.expires_at,
      });
    } catch (error) {
      if (error instanceof IamBillingAuthorizationError) throw error;
      if (this.#shutdown.signal.aborted)
        throw new IamBillingAuthorizationError("SHUTTING_DOWN");
      if (input.signal.aborted)
        throw new IamBillingAuthorizationError("ABORTED");
      throw this.#mapSdkError(error);
    }
  }

  #mapSdkError(error: unknown): IamBillingAuthorizationError {
    if (!(error instanceof IamClientError))
      return new IamBillingAuthorizationError("UNAVAILABLE");
    if (error.kind === "request")
      return new IamBillingAuthorizationError("AUTHORIZATION_INVALID");
    if (error.kind === "aborted")
      return new IamBillingAuthorizationError("ABORTED");
    if (error.kind === "api") {
      if (error.status === 400)
        return new IamBillingAuthorizationError("AUTHORIZATION_INVALID");
      if ([401, 403, 404, 409].includes(error.status ?? 0))
        return new IamBillingAuthorizationError("DENIED");
    }
    return new IamBillingAuthorizationError("UNAVAILABLE");
  }

  #validInput(input: AuthorizeIamBillingInput): boolean {
    return (
      isIdentity(input.tenantId) &&
      isIdentity(input.payerUserId) &&
      isIdentity(input.runId, 512) &&
      isIdentity(input.executionSessionId, 512) &&
      typeof input.leaseGeneration === "string" &&
      /^[1-9][0-9]{0,15}$(?![\s\S])/u.test(input.leaseGeneration) &&
      BigInt(input.leaseGeneration) <= BigInt(Number.MAX_SAFE_INTEGER) &&
      /^[0-9a-f]{64}$(?![\s\S])/u.test(input.requestBindingSha256) &&
      typeof input.executionProof === "string" &&
      input.executionProof.length > 0 &&
      input.executionProof.length <= 16_384 &&
      !/[^\x21-\x7e]/u.test(input.executionProof) &&
      /^[A-Za-z0-9._:-]{1,255}$(?![\s\S])/u.test(input.requestId) &&
      input.signal instanceof AbortSignal
    );
  }
}
