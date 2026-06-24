import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_IDS: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gemini-2.0-flash'),
  OPENAI_BASE_URL: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.string().default('3000'),
  CRON_SCHEDULE: z.string().default('*/30 * * * *'),
  PARSER_TIMEOUT: z.string().default('30000'),
  PARSER_MAX_RETRIES: z.string().default('3'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    adminIds: env.TELEGRAM_ADMIN_IDS
      ? env.TELEGRAM_ADMIN_IDS.split(',').map((id) => parseInt(id.trim(), 10)).filter(Boolean)
      : [],
  },
  database: {
    url: env.DATABASE_URL,
  },
  openai: {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    baseUrl: env.OPENAI_BASE_URL,
  },
  app: {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: parseInt(env.PORT, 10),
    isDev: env.NODE_ENV === 'development',
  },
  cron: {
    schedule: env.CRON_SCHEDULE,
  },
  parser: {
    timeout: parseInt(env.PARSER_TIMEOUT, 10),
    maxRetries: parseInt(env.PARSER_MAX_RETRIES, 10),
  },
};

export type Config = typeof config;
