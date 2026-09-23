/**
 * Environment, validated once at boot.
 *
 * A misconfigured deployment should fail in a fraction of a second with a
 * readable list of what is missing, not 500 on the first request that happens to
 * need a variable.
 */
import { z } from 'zod';
import 'dotenv/config';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  MONGODB_URI: z.string().default(''),
  MONGODB_DB_NAME: z.string().default('interview_prep_kit'),

  AUTH_JWT_SECRET: z.string().default(''),
  AUTH_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(24),
  COOKIE_NAME: z.string().default('ipk_session'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  GROQ_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('openai/gpt-oss-120b'),
  LLM_MODEL_FAST: z.string().default('openai/gpt-oss-20b'),
  LLM_MODEL_OVERFLOW: z.string().default('qwen/qwen3.8-27b'),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4000),

  BRAVE_SEARCH_API_KEY: z.string().optional(),

  ALLOW_PRIVATE_NETWORK: z.string().optional(),
  PRIVATE_NETWORK_ALLOWED_PORTS: z.string().default('8099,3000,8080'),

  GENERATION_BUDGET_MS: z.coerce.number().int().positive().default(240_000),
  JOB_CONCURRENCY: z.coerce.number().int().positive().default(2),
  JOB_LEASE_MS: z.coerce.number().int().positive().default(120_000),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }

  const env = parsed.data;
  const missing: string[] = [];
  if (env.MONGODB_URI === '') missing.push('MONGODB_URI');
  if (env.AUTH_JWT_SECRET === '') missing.push('AUTH_JWT_SECRET');
  if (env.GROQ_API_KEY === '') missing.push('GROQ_API_KEY');

  if (missing.length > 0 && env.NODE_ENV !== 'test') {
    throw new Error(
      `The API needs these variables set: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env and fill them in.\n' +
        'Note: the batch entry point (npm run evaluate) needs only GROQ_API_KEY and no database.',
    );
  }

  if (env.NODE_ENV === 'production' && env.AUTH_JWT_SECRET.length < 32) {
    throw new Error('AUTH_JWT_SECRET must be at least 32 characters in production');
  }
  if (env.NODE_ENV === 'production' && env.COOKIE_SAMESITE === 'none') {
    // Documented in .env.example next to the variable: SameSite=None makes the
    // cookie usable cross-site, which reintroduces CSRF and would require a
    // double-submit token. The proxy design exists so this is never needed.
    throw new Error(
      'COOKIE_SAMESITE=none requires CSRF tokens, which this build does not implement. ' +
        'Use the Next.js rewrite proxy so the cookie stays first-party.',
    );
  }

  return env;
}

let cached: Env | null = null;

export function env(): Env {
  cached ??= load();
  return cached;
}

/** Test seam, so a suite can build an app with its own configuration. */
export function setEnvForTesting(value: Env): void {
  cached = value;
}
