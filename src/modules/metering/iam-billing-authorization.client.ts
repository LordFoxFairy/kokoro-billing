import { IamClient, IamClientError } from "@kokoro/iam-client";
import type { OnModuleDestroy } from "@nestjs/common";
import { IamBillingAuthorizationError } from "./iam-billing-authorization.error.js";
import type {
  AuthorizeIamBillingInput,
  IamBillingAuthorization,
  ResolvedIamBillingAuthorizationOptions,
} from "./iam-billing-authorization.options.js";

const isIdentity = (value: string): boolean => {
  const length = [...value].length;
  return (
    length > 0 &&
    length <= 255 &&
    !value.includes("\0") &&
    !/[\uD800-\uDFFF]/u.test(value)
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
        { accessToken: input.consumptionToken },
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
        !isIdentity(decision.session_id) ||
        !isIdentity(decision.client_id) ||
        !isIdentity(decision.decision_ref)
      )
        throw new IamBillingAuthorizationError("BINDING_MISMATCH");
      if (
        input.billingSubject.kind === "user" &&
        input.billingSubject.ref !== decision.user_id
      )
        throw new IamBillingAuthorizationError("BINDING_MISMATCH");
      const expiry = exactUtcInstant(decision.expires_at);
      if (expiry === null || expiry <= Date.now())
        throw new IamBillingAuthorizationError("EXPIRED");
      return Object.freeze({ payerUserId: decision.user_id });
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
      if ([401, 403, 409].includes(error.status ?? 0))
        return new IamBillingAuthorizationError("DENIED");
    }
    return new IamBillingAuthorizationError("UNAVAILABLE");
  }

  #validInput(input: AuthorizeIamBillingInput): boolean {
    return (
      isIdentity(input.tenantId) &&
      isIdentity(input.billingSubject.ref) &&
      ["user", "project", "organization", "service"].includes(
        input.billingSubject.kind,
      ) &&
      input.consumptionToken.length > 0 &&
      input.consumptionToken.length <= 16_384 &&
      /^[A-Za-z0-9._:-]{1,255}$/u.test(input.requestId) &&
      input.signal instanceof AbortSignal
    );
  }
}
