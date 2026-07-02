import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // OCR provider selection. 'local' (default) = self-hosted vision model, fully offline.
  OCR_PROVIDER: z.enum(['local', 'claude']).default('local'),

  // Local provider (OpenAI-compatible server; Ollama by default, vLLM also supported).
  OCR_LOCAL_BASE_URL: z.string().default('http://localhost:11434/v1'),
  OCR_LOCAL_MODEL: z.string().default('qwen2.5vl:3b'),
  OCR_LOCAL_API_KEY: z.string().default(''),

  // Claude provider (only used when OCR_PROVIDER=claude).
  ANTHROPIC_API_KEY: z.string().default(''),
  OCR_MODEL: z.string().default('claude-sonnet-5'),
  OCR_ESCALATION_MODEL: z.string().default('claude-opus-4-8'),

  // Kroger/Fry's integration (developer.kroger.com app credentials).
  KROGER_CLIENT_ID: z.string().default(''),
  KROGER_CLIENT_SECRET: z.string().default(''),
  KROGER_REDIRECT_URI: z.string().default('http://localhost:8090/api/integrations/kroger/callback'),

  STORAGE_DIR: z.string().default('./storage'),
  NODE_ENV: z.string().default('development'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
