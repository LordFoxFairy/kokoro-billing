import { Module, type DynamicModule } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module.js";
import { BillingHttpModule } from "./http/billing-http.module.js";
import type { BillingRuntimeConfig } from "./config/runtime-config.js";

@Module({})
export class AppModule {
  static register(config: BillingRuntimeConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.register({ databaseUrl: config.databaseUrl }),
        BillingHttpModule.register(config.auth),
      ],
    };
  }
}
