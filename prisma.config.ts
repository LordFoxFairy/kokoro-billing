import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "database/generated/schema.prisma",
  datasource: {
    url: env("PRISMA_DATABASE_URL"),
  },
});
