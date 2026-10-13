import { Module, type DynamicModule } from "@nestjs/common";
import type { BillingRuntimeConfig } from "./config/runtime-config.js";
import { DatabaseModule } from "./database/database.module.js";
import { BillingHttpModule } from "./http/billing-http.module.js";

@Module({})
export class AppModule {
  static register(config: BillingRuntimeConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.register({ databaseUrl: config.databaseUrl }),
        BillingHttpModule.register({
          mode: config.authMode,
          internalServiceSecret: config.internalServiceSecret,
          bffServiceToken: config.bffServiceToken,
          operatorProxySecret: config.operatorProxySecret,
          ...(config.jwksUrl === undefined ? {} : { jwksUrl: config.jwksUrl }),
          issuer: config.issuer,
          ...(config.audience === undefined
            ? {}
            : { audience: config.audience }),
        }),
      ],
    };
  }
}
