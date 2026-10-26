import { snapshotExpectedAgentModelCallBound } from "./agent-model-call-bound.js";
import type {
  ExpectedAgentModelCallBound,
  DecodedAgentModelCallBound,
} from "./agent-model-call-bound.js";
import { AgentModelCallBoundError } from "./agent-model-call-bound.error.js";
import { decodeAgentBoundResponse } from "./agent-usage-evidence-response.js";
import { MAX_AGENT_BOUND_RESPONSE_BYTES } from "./agent-usage-json.js";
import type { OnModuleDestroy } from "@nestjs/common";
import { AgentUsageReaderError } from "./agent-usage-evidence-reader.error.js";
import { AgentUsageEvidenceError } from "./agent-usage-evidence.error.js";
import { resolveAgentUsageReaderOptions } from "./agent-usage-evidence-reader.options.js";
import type { AgentUsageReaderOptions } from "./agent-usage-evidence-reader.options.js";
import type {
  DecodedAgentUsageEvidence,
  ExpectedAgentUsageEvidence,
} from "./agent-usage-evidence.js";
import { decodeAgentEvidenceResponse } from "./agent-usage-evidence-response.js";
import { MAX_AGENT_EVIDENCE_RESPONSE_BYTES } from "./agent-usage-json.js";

export type ReadAgentUsageEvidenceInput = Readonly<{
  expected: ExpectedAgentUsageEvidence;
  requestId: string;
  signal: AbortSignal;
}>;

export type ReadAgentModelCallBoundInput = Readonly<{
  expected: ExpectedAgentModelCallBound;
  requestId: string;
  signal: AbortSignal;
}>;

/** A private Metering dependency. Reads facts only; never grants or settles funds. */
export class AgentUsageEvidenceReader implements OnModuleDestroy {
  readonly #options: ReturnType<typeof resolveAgentUsageReaderOptions>;
  readonly #shutdown = new AbortController();
  readonly #requests = new Set<Promise<unknown>>();

  public constructor(options: AgentUsageReaderOptions) {
    this.#options = resolveAgentUsageReaderOptions(options);
  }

  public read(
    input: ReadAgentUsageEvidenceInput,
  ): Promise<DecodedAgentUsageEvidence> {
    if (this.#shutdown.signal.aborted)
      return Promise.reject(new AgentUsageReaderError("SHUTTING_DOWN"));
    if (input.signal.aborted)
      return Promise.reject(new AgentUsageReaderError("ABORTED"));
    let expected: ExpectedAgentUsageEvidence;
    try {
      expected = structuredClone(input.expected);
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
      if (
        !uuid.test(expected.identity.attempt_id) ||
        !uuid.test(expected.identity.event_id) ||
        !/^[\x21-\x7e]{1,255}$/u.test(expected.identity.tenant_ref) ||
        !/^[A-Za-z0-9._:-]{1,255}$/u.test(input.requestId)
      )
        throw new AgentUsageReaderError("REQUEST_INVALID");
    } catch {
      return Promise.reject(new AgentUsageReaderError("REQUEST_INVALID"));
    }
    const requestId = input.requestId;
    const request = this.#read({
      signal: input.signal,
      requestId,
      tenant: expected.identity.tenant_ref,
      path: `/v1/model-call-attempts/${encodeURIComponent(expected.identity.attempt_id)}/usage-evidence/${encodeURIComponent(expected.identity.event_id)}`,
      maxBytes: MAX_AGENT_EVIDENCE_RESPONSE_BYTES,
      usage: true,
      decode: (raw) => decodeAgentEvidenceResponse(raw, expected, requestId),
    });
    this.#requests.add(request);
    void request.finally(() => this.#requests.delete(request)).catch(() => {});
    return request;
  }

  public readBound(
    input: ReadAgentModelCallBoundInput,
  ): Promise<DecodedAgentModelCallBound> {
    if (this.#shutdown.signal.aborted)
      return Promise.reject(new AgentUsageReaderError("SHUTTING_DOWN"));
    if (input.signal.aborted)
      return Promise.reject(new AgentUsageReaderError("ABORTED"));
    let expected: ExpectedAgentModelCallBound;
    try {
      expected = snapshotExpectedAgentModelCallBound(input.expected);
      if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.requestId))
        throw new AgentUsageReaderError("REQUEST_INVALID");
    } catch {
      return Promise.reject(new AgentUsageReaderError("REQUEST_INVALID"));
    }
    const requestId = input.requestId;
    const request = this.#read({
      signal: input.signal,
      requestId,
      tenant: expected.tenantRef,
      path: `/v1/model-call-bounds/${encodeURIComponent(expected.executionBoundRef)}`,
      maxBytes: MAX_AGENT_BOUND_RESPONSE_BYTES,
      usage: false,
      decode: (raw, status) =>
        decodeAgentBoundResponse(raw, expected, requestId, status),
    });
    this.#requests.add(request);
    void request.finally(() => this.#requests.delete(request)).catch(() => {});
    return request;
  }

  public async onModuleDestroy(): Promise<void> {
    this.#shutdown.abort();
    await Promise.allSettled([...this.#requests]);
  }

  async #read<T>(
    input: Readonly<{
      signal: AbortSignal;
      requestId: string;
      tenant: string;
      path: string;
      maxBytes: number;
      usage: boolean;
      decode: (raw: Uint8Array, status: number) => T;
    }>,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.#options.deadlineMs);
    const signal = AbortSignal.any([
      input.signal,
      timeout.signal,
      this.#shutdown.signal,
    ]);
    let response: Response | undefined;
    try {
      response = await fetch(`${this.#options.baseUrl}${input.path}`, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          authorization: `Bearer ${this.#options.machineBearerToken}`,
          accept: "application/json",
          "x-request-id": input.requestId,
          "x-kokoro-tenant-ref": input.tenant,
        },
      });
      if (input.usage) {
        if (response.status === 401 || response.status === 403)
          throw new AgentUsageReaderError("DENIED");
        if (response.status === 404)
          throw new AgentUsageReaderError("NOT_FOUND");
        if (response.status !== 200)
          throw new AgentUsageReaderError("UNAVAILABLE");
      }
      const length = response.headers.get("content-length");
      if (
        response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-request-id") !== input.requestId ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
          response.headers.get("content-type") ?? "",
        ) ||
        (length !== null &&
          (!/^[0-9]+$/u.test(length) ||
            BigInt(length) > BigInt(input.maxBytes))) ||
        !response.body
      )
        throw new AgentUsageReaderError("CONTRACT_INVALID");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > input.maxBytes)
            throw new AgentUsageReaderError("CONTRACT_INVALID");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      signal.throwIfAborted();
      return input.decode(Buffer.concat(chunks, size), response.status);
    } catch (error) {
      if (this.#shutdown.signal.aborted)
        throw new AgentUsageReaderError("SHUTTING_DOWN");
      if (input.signal.aborted) throw new AgentUsageReaderError("ABORTED");
      if (timeout.signal.aborted) throw new AgentUsageReaderError("TIMEOUT");
      if (error instanceof AgentUsageReaderError) throw error;
      if (
        error instanceof AgentUsageEvidenceError ||
        error instanceof AgentModelCallBoundError
      )
        throw new AgentUsageReaderError("CONTRACT_INVALID");
      throw new AgentUsageReaderError("UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => {});
    }
  }
}
