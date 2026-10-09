import { afterAll, describe, expect, it } from "vitest";
import { connectDb, disconnectDb, prisma } from "./db.js";

// Integration tests: need Postgres running (`docker compose up -d postgres`)
describe("database connection", () => {
  afterAll(async () => {
    await disconnectDb();
  });

  it("connects to Postgres", async () => {
    await expect(connectDb()).resolves.toBeUndefined();
  });

  it("runs a query against the configured database", async () => {
    const rows = await prisma.$queryRaw<{ db: string }[]>`
      SELECT current_database() AS db
    `;

    expect(rows).toEqual([{ db: "fusion_test" }]);
  });
});
