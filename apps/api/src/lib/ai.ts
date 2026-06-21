import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { requireAiEnv } from './env.js';
import { recordUsage } from './ai-usage.js';

// Lazily-constructed AI clients. requireAiEnv() throws if keys are missing, so
// these are only ever reached on the Milestone 2 (post-approval) path — never
// during ingestion. Model IDs are pinned per the kickoff tech stack.

export const MODELS = {
  relevance: 'claude-haiku-4-5-20251001', // cheap, high-volume scoring
  extraction: 'claude-sonnet-4-6', // quality extraction + drafting
  embedding: 'text-embedding-3-small', // 1536 dims
} as const;

export const EMBEDDING_DIMENSIONS = 1536;

let anthropic: Anthropic | null = null;
let openai: OpenAI | null = null;

export function getAnthropic(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: requireAiEnv().anthropicApiKey });
  return anthropic;
}

export function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: requireAiEnv().openaiApiKey });
  return openai;
}

// Recording wrappers — use these instead of the raw SDK so every call's token
// usage is attributed (to the org in the current withOrg context). `operation`
// labels the call site for the analytics breakdown.

export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  operation: string,
): Promise<Anthropic.Message> {
  const res = await getAnthropic().messages.create(params);
  recordUsage({
    provider: 'anthropic',
    model: params.model,
    operation,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
  });
  return res;
}

export async function createEmbedding(
  params: OpenAI.EmbeddingCreateParams,
  operation: string,
): Promise<OpenAI.CreateEmbeddingResponse> {
  const res = await getOpenAI().embeddings.create(params);
  recordUsage({
    provider: 'openai',
    model: typeof params.model === 'string' ? params.model : MODELS.embedding,
    operation,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: 0,
  });
  return res;
}
