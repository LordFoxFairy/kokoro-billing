import {
  Controller,
  Get,
  Post,
  Inject,
  Req,
  Res,
  UseGuards,
  NotFoundException,
} from "@nestjs/common";
import type { FastifyRequest, FastifyReply } from "fastify";
import { CreditAccountGuard } from "../../http/credit-account.guard.js";
import {
  BILLING_SCHEMA_VALIDATOR,
  type BillingSchemaValidator,
} from "../../infrastructure/auth/billing-auth.types.js";
import { ModelAdmissionService } from "./model-admission.service.js";
import { MODEL_ADMISSION_DEADLINE } from "./model-admission.options.js";
import {
  readModelAdmissionInput,
  readModelAdmissionId,
  modelAdmissionContext,
  modelAdmissionPath,
} from "./model-admission.input.js";
import { mapModelAdmission } from "./model-admission.mapper.js";
@Controller("v1/internal/billing/admissions")
@UseGuards(CreditAccountGuard)
export class ModelAdmissionController {
  constructor(
    @Inject(ModelAdmissionService)
    private readonly service: ModelAdmissionService,
    @Inject(BILLING_SCHEMA_VALIDATOR)
    private readonly schemas: BillingSchemaValidator,
    @Inject(MODEL_ADMISSION_DEADLINE) private readonly deadline: number,
  ) {}
  // IncomingMessage.close also fires on normal body completion; only abort/unfinished reply means cancellation.
  private async scoped<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!reply.raw.writableFinished) abort();
    };
    const timer = setTimeout(abort, this.deadline);
    timer.unref();
    request.raw.once("aborted", abort);
    reply.raw.once("close", close);
    if (request.raw.aborted) abort();
    try {
      return await work(controller.signal);
    } finally {
      clearTimeout(timer);
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", close);
    }
  }
  @Post()
  async create(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = readModelAdmissionInput(request, this.schemas);
    return this.scoped(request, reply, async (signal) => {
      const result = await this.service.create(
        modelAdmissionContext(request, signal),
        input.command,
        input.consumptionToken,
      );
      const response = mapModelAdmission({
        ...result,
        attemptBindingDigest: input.command.attemptBindingDigest,
        plannedDigest: input.command.plannedDigest,
        finalRequestDigest: input.command.finalRequestDigest,
        status: "held",
        updatedAt: result.createdAt,
      });
      this.schemas.assert("AdmissionResponse", response);
      reply.header("location", `${modelAdmissionPath}/${result.admissionId}`);
      return response;
    });
  }
  @Get(":admission_id")
  async read(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const id = readModelAdmissionId(request);
    return this.scoped(request, reply, async (signal) => {
      const value = await this.service.read(
        modelAdmissionContext(request, signal),
        id,
      );
      if (value === null) throw new NotFoundException();
      const response = mapModelAdmission(value);
      this.schemas.assert("AdmissionResponse", response);
      return response;
    });
  }
}
