import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  SERVICE_NAME: z.string().min(1).default('core'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
