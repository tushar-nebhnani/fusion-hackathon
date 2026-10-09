import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "./env.js";

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

// Fails fast at startup if Postgres is unreachable
export async function connectDb(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
