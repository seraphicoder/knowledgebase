// Centralized, validated environment access.
// AI keys are intentionally OPTIONAL: Milestone 1 (ingestion) must run with the
// Anthropic and OpenAI keys absent. They are only required by Milestone 2 code,
// which calls requireAiEnv() at the point of use.

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function required(name: string): string {
  const v = optional(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const env = {
  // Supabase — required for any DB access.
  supabaseUrl: () => required('SUPABASE_URL'),
  supabaseServiceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseAnonKey: () => optional('SUPABASE_ANON_KEY'),

  // Credential encryption for ingestion_sources.config.
  configEncryptionKey: () => optional('CONFIG_ENCRYPTION_KEY'),

  // AI — optional at load time, required only inside the M2 pipeline.
  anthropicApiKey: () => optional('ANTHROPIC_API_KEY'),
  openaiApiKey: () => optional('OPENAI_API_KEY'),

  port: () => Number(process.env.PORT ?? 3000),
  nodeEnv: () => process.env.NODE_ENV ?? 'development',

  // Comma-separated list of allowed browser origins for CORS (e.g. a separately
  // hosted frontend URL). Unset = allow all (fine for local dev, and a no-op
  // when the SPA is served same-origin from this server).
  corsOrigins: () =>
    (process.env.WEB_ORIGIN ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),

  // Directory of the built SPA to serve (single-service deploy). Relative to the
  // process cwd (apps/api at runtime). The api build copies apps/web/dist here.
  webDistDir: () => process.env.WEB_DIST_DIR ?? './public',
};

/** Guards Milestone 2 entry points. Never call this from ingestion code. */
export function requireAiEnv(): { anthropicApiKey: string; openaiApiKey: string } {
  const anthropicApiKey = optional('ANTHROPIC_API_KEY');
  const openaiApiKey = optional('OPENAI_API_KEY');
  if (!anthropicApiKey) throw new Error('Missing required environment variable: ANTHROPIC_API_KEY');
  if (!openaiApiKey) throw new Error('Missing required environment variable: OPENAI_API_KEY');
  return { anthropicApiKey, openaiApiKey };
}
