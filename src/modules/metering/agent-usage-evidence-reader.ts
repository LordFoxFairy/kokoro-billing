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
import {
  MAX_AGENT_EVIDENCE_RESPONSE_BYTES,
  MAX_AGENT_PREPARED_RESPONSE_BYTES,
} from "./agent-usage-json.js";
import {
  copyPreparedExpectation,
  decodeAgentPreparedResponse,
} from "./agent-prepared-call.js";
import type {
  ExpectedPreparedModelCall,
  DecodedPreparedModelCall,
} from "./agent-prepared-call.js";

export type ReadAgentUsageEvidenceInput = Readonly<{
  expected: ExpectedAgentUsageEvidence;
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
    const requestId = input.requestId;
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
        !/^[A-Za-z0-9._:-]{1,255}$/u.test(requestId)
      )
        throw new AgentUsageReaderError("REQUEST_INVALID");
    } catch {
      return Promise.reject(new AgentUsageReaderError("REQUEST_INVALID"));
    }
    const request = this.#read(
      { ...input, requestId, tenant: expected.identity.tenant_ref },
      `/v1/model-call-attempts/${encodeURIComponent(expected.identity.attempt_id)}/usage-evidence/${encodeURIComponent(expected.identity.event_id)}`,
      MAX_AGENT_EVIDENCE_RESPONSE_BYTES,
      (raw) => decodeAgentEvidenceResponse(raw, expected, requestId),
    );
    this.#requests.add(request);
    void request.finally(() => this.#requests.delete(request)).catch(() => {});
    return request;
  }

  public readPrepared(
    input: Readonly<{
      expected: ExpectedPreparedModelCall;
      requestId: string;
      signal: AbortSignal;
    }>,
  ): Promise<DecodedPreparedModelCall> {
    const requestId = input.requestId;
    if (this.#shutdown.signal.aborted)
      return Promise.reject(new AgentUsageReaderError("SHUTTING_DOWN"));
    if (input.signal.aborted)
      return Promise.reject(new AgentUsageReaderError("ABORTED"));
    let expected: ExpectedPreparedModelCall;
    try {
      expected = copyPreparedExpectation(input.expected);
      if (!/^[A-Za-z0-9._:-]{1,255}$/u.test(requestId)) throw new Error();
    } catch {
      return Promise.reject(new AgentUsageReaderError("REQUEST_INVALID"));
    }
    const request = this.#read(
      { ...input, requestId, tenant: expected.tenantId },
      `/v1/model-call-attempts/${encodeURIComponent(expected.attemptId)}/prepared`,
      MAX_AGENT_PREPARED_RESPONSE_BYTES,
      (raw) => decodeAgentPreparedResponse(raw, expected, requestId),
    );
    this.#requests.add(request);
    void request.finally(() => this.#requests.delete(request)).catch(() => {});
    return request;
  }

  public async onModuleDestroy(): Promise<void> {
    this.#shutdown.abort();
    await Promise.allSettled([...this.#requests]);
  }

  async #read<T>(
    input: Readonly<{ tenant: string; requestId: string; signal: AbortSignal }>,
    path: string,
    maximumBytes: number,
    decode: (raw: Uint8Array) => T,
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
      response = await fetch(`${this.#options.baseUrl}${path}`, {
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
      if (response.status === 401 || response.status === 403)
        throw new AgentUsageReaderError("DENIED");
      if (response.status === 404) throw new AgentUsageReaderError("NOT_FOUND");
      if (response.status !== 200)
        throw new AgentUsageReaderError("UNAVAILABLE");
      const length = response.headers.get("content-length");
      if (
        response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-request-id") !== input.requestId ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
          response.headers.get("content-type") ?? "",
        ) ||
        (length !== null &&
          (!/^[0-9]+$/u.test(length) ||
            BigInt(length) > BigInt(maximumBytes))) ||
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
          if (size > maximumBytes)
            throw new AgentUsageReaderError("CONTRACT_INVALID");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      signal.throwIfAborted();
      return decode(Buffer.concat(chunks, size));
    } catch (error) {
      if (this.#shutdown.signal.aborted)
        throw new AgentUsageReaderError("SHUTTING_DOWN");
      if (input.signal.aborted) throw new AgentUsageReaderError("ABORTED");
      if (timeout.signal.aborted) throw new AgentUsageReaderError("TIMEOUT");
      if (error instanceof AgentUsageReaderError) throw error;
      if (error instanceof AgentUsageEvidenceError)
        throw new AgentUsageReaderError("CONTRACT_INVALID");
      throw new AgentUsageReaderError("UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => {});
    }
  }
}
