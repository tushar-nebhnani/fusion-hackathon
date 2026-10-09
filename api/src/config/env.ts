import "dotenv/config";
import { z } from "zod";

// A blank line in .env ("KEY=") means "not set"
const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default("redis://localhost:6379"),
  // The climate agent runs only when a key is present and it is not switched off
  OPENAI_API_KEY: optionalSecret,
  CLIMATE_AGENT_ENABLED: z.enum(["true", "false"]).default("true"),
  CLIMATE_AGENT_MODEL: z.string().min(1).default("gpt-5-nano"),
});

export const env = schema.parse(process.env);
