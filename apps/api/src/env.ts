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
  // Text LLM for free-form price parsing (same local server; a text model, not the VLM).
  LLM_MODEL: z.string().default('qwen2.5:7b'),

  // Claude provider (only used when OCR_PROVIDER=claude).
  ANTHROPIC_API_KEY: z.string().default(''),
  OCR_MODEL: z.string().default('claude-sonnet-5'),
  OCR_ESCALATION_MODEL: z.string().default('claude-opus-4-8'),

  // Kroger/Fry's integration (developer.kroger.com app credentials).
  KROGER_CLIENT_ID: z.string().default(''),
  KROGER_CLIENT_SECRET: z.string().default(''),
  KROGER_REDIRECT_URI: z.string().default('http://localhost:8090/api/integrations/kroger/callback'),
  // New-portal (CE) apps: https://api-ce.kroger.com/v1
  KROGER_API_BASE: z.string().default('https://api.kroger.com/v1'),

  // USDA FoodData Central (nutrition source). Free key: https://fdc.nal.usda.gov/api-key-signup.html
  // DEMO_KEY works but is heavily rate-limited — set a real key in .env.
  USDA_FDC_API_KEY: z.string().default('DEMO_KEY'),
  USDA_FDC_API_BASE: z.string().default('https://api.nal.usda.gov/fdc/v1'),

  // UPCitemdb (last-resort description + images). Empty key = free trial endpoint (~100/day).
  UPCITEMDB_KEY: z.string().default(''),
  UPCITEMDB_API_BASE: z.string().default('https://api.upcitemdb.com/prod/v1'),

  STORAGE_DIR: z.string().default('./storage'),
  NODE_ENV: z.string().default('development'),

  // Passwordless auth (magic links). EMAIL DELIVERY IS STUBBED until pantrezy.com is live.
  WEB_BASE_URL: z.string().default('http://localhost:8090'),
  SESSION_DAYS: z.coerce.number().default(90), // device cache window (~3 months)
  MAGIC_LINK_MINUTES: z.coerce.number().default(20),

  // Cloudflare Access (Zero Trust) in front of the app. When both are set, requests carrying
  // a verified Cf-Access-Jwt-Assertion are logged in as that email. Team domain e.g.
  // "yourteam.cloudflareaccess.com"; AUD is the Access application's Audience tag.
  CF_ACCESS_TEAM_DOMAIN: z.string().default(''),
  CF_ACCESS_AUD: z.string().default(''),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
