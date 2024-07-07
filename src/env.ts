import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    HOST_URL: z.string().url(),
    DISCORD_WEBHOOK_URL: z.string().url(),
    PUBSUB_SECRET: z.string().min(32),
    DB_PATH: z.string().default(`${process.cwd()}/data/db.sqlite`),
    SUBSCRIPTIONS_PATH: z
      .string()
      .default(`${process.cwd()}/data/subscriptions.json`),
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    PORT: z.number().int().positive().default(3000),
  },
  runtimeEnv: process.env,
});
