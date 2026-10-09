import { execFileSync } from "node:child_process";

// Applies migrations to the test database before any test runs. The config
// has already pointed DATABASE_URL at it; Prisma creates it if it is missing.
export default function setup(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!new URL(url).pathname.endsWith("_test")) {
    throw new Error("Refusing to run tests: DATABASE_URL is not a *_test database");
  }
  execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "pipe" });
}
