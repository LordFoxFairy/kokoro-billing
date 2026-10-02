import { Inject, InternalServerErrorException, Module } from "@nestjs/common";
import type { DynamicModule, NestModule } from "@nestjs/common";
import { APP_FILTER, HttpAdapterHost } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import * as generatedSchemas from "../generated/billing-api/schemas.gen.js";
import provenance from "../generated/billing-api/provenance.json" with { type: "json" };
import { validateBillingPersonalHttpOptions } from "../config/runtime-config.js";
import { createBillingPersonalAuth } from "../infrastructure/auth/billing-auth.js";
import { billingHeaderCount } from "../infrastructure/auth/billing-identity-header.js";
import {
  BILLING_PERSONAL_AUTH,
  BILLING_PERSONAL_HTTP_OPTIONS,
  BILLING_SCHEMA_VALIDATOR,
} from "../infrastructure/auth/billing-auth.types.js";
import type {
  BillingAuthOptions,
  BillingPersonalHttpOptions,
  BillingSchemaValidator,
} from "../infrastructure/auth/billing-auth.types.js";
import { CreditModule } from "../modules/credit/credit.module.js";
import { CreditReadController } from "../modules/credit/credit-read.controller.js";
import { PersonalGuard } from "./personal.guard.js";
import { ErrorFilter } from "./error.filter.js";

@Module({})
export class BillingHttpModule implements NestModule {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapters: HttpAdapterHost,
  ) {}
  configure(): void {
    const adapter = this.adapters.httpAdapter;
    if (!(adapter instanceof FastifyAdapter))
      throw new Error("Billing HTTP requires FastifyAdapter");
    const fastify = adapter.getInstance<FastifyInstance>();
    fastify.addHook("onRequest", (request, reply, done) => {
      const supplied = request.headers["x-request-id"];
      request.id =
        typeof supplied === "string" &&
        /^[A-Za-z0-9._:-]{1,255}$/u.test(supplied) &&
        billingHeaderCount(request.raw.rawHeaders, "x-request-id") === 1
          ? supplied
          : randomUUID();
      reply
        .header("x-request-id", request.id)
        .header("cache-control", "no-store");
      done();
    });
    fastify.addHook("onResponse", (request, reply, done) => {
      request.log.info(
        {
          service: "kokoro-billing",
          operation: request.routeOptions.url ?? "unmatched",
          request_id: request.id,
          trace_id: request.id,
          result: reply.statusCode,
          duration: reply.elapsedTime,
        },
        "Billing HTTP request completed",
      );
      done();
    });
  }
  static register(options: BillingAuthOptions): DynamicModule {
    const config = validateBillingPersonalHttpOptions(options);
    return {
      module: BillingHttpModule,
      imports: [CreditModule],
      controllers: [CreditReadController],
      providers: [
        { provide: BILLING_PERSONAL_HTTP_OPTIONS, useValue: config },
        {
          provide: BILLING_PERSONAL_AUTH,
          inject: [BILLING_PERSONAL_HTTP_OPTIONS],
          useFactory: (resolved: BillingPersonalHttpOptions) =>
            createBillingPersonalAuth(resolved),
        },
        {
          provide: BILLING_SCHEMA_VALIDATOR,
          useFactory: (): BillingSchemaValidator => {
            const ajv = new Ajv2020({
              strict: true,
              coerceTypes: false,
              useDefaults: false,
              removeAdditional: false,
            });
            formatsModule.default(ajv);
            ajv.addKeyword({
              keyword: "x-kokoro-credit-unit",
              schemaType: "object",
              valid: true,
            });
            const bindings = Object.entries(provenance.schema_bindings);
            const exports = new Map<string, object>(
              Object.entries(generatedSchemas),
            );
            if (
              bindings.length !== 43 ||
              exports.size !== bindings.length ||
              new Set(bindings.map(([, exported]) => exported)).size !==
                exports.size
            )
              throw new Error("Billing schema registry is not closed");
            for (const [name, exported] of bindings) {
              const schema = exports.get(exported);
              if (schema === undefined)
                throw new Error("Missing Billing generated schema");
              ajv.addSchema(schema, `#/components/schemas/${name}`);
            }
            const validators = new Map(
              bindings.map(([name]) => {
                const validator = ajv.getSchema(`#/components/schemas/${name}`);
                if (validator === undefined)
                  throw new Error("Uncompiled Billing schema");
                return [name, validator] as const;
              }),
            );
            return Object.freeze({
              names: Object.freeze(bindings.map(([name]) => name)),
              assert: (name, value) => {
                const validator = validators.get(name);
                if (validator === undefined || !validator(value))
                  throw new InternalServerErrorException();
              },
            });
          },
        },
        PersonalGuard,
        ErrorFilter,
        { provide: APP_FILTER, useExisting: ErrorFilter },
      ],
      exports: [
        BILLING_PERSONAL_HTTP_OPTIONS,
        BILLING_PERSONAL_AUTH,
        BILLING_SCHEMA_VALIDATOR,
        PersonalGuard,
      ],
    };
  }
}
