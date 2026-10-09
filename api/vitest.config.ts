import "dotenv/config";
import { defineConfig } from "vitest/config";

// Tests get their own database (<name>_test) so they never touch dev data
const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost:5432/fusion");
if (!url.pathname.endsWith("_test")) url.pathname += "_test";
process.env.DATABASE_URL = url.toString();

// Same idea for Redis: tests use logical database 1, dev uses 0
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
redisUrl.pathname = "/1";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: "./vitest.global-setup.ts",
    // A cache miss stores ~30 years of daily metrics
    testTimeout: 30_000,
    env: { DATABASE_URL: url.toString(), REDIS_URL: redisUrl.toString(), NODE_ENV: "test" },
  },
});
