import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "database/generated/schema.prisma",
  datasource: {
    url: process.env.PRISMA_DATABASE_URL!,
  },
});
