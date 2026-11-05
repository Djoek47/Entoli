/**
 * Claude calls shared by the analyzer and the runtime API.
 * Structured output (json_schema) so the reply is parsed, never scraped;
 * server-side refusal fallback on; token usage and cost returned with every
 * call so the caller can log and meter it.
 */
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = process.env.ENTOLI_MODEL || 'claude-opus-5-5';

/** USD per million tokens. Cache writes at the 5-minute rate (1.25x input). */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export type Usage = { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number };

/** Cost in micro-dollars ($/M tokens is micro-dollars per token). Unknown models price as Opus 5.5. */
export function costMicros(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5']!;
  return Math.round(u.tokensIn * p.in + u.tokensOut * p.out + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite);
}

export class AiError extends Error {
  constructor(message: string, readonly reason: 'refusal' | 'truncated' | 'invalid_json' | 'no_key' | 'api', readonly usage?: Usage, readonly model?: string) {
    super(message);
    this.name = 'AiError';
  }
}

export type AskJsonOptions = {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  client?: Anthropic;
};

export type AskJsonResult<T> = { data: T; usage: Usage; costMicros: number; model: string };

export function hasAnthropicKey(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function askJson<T>(o: AskJsonOptions): Promise<AskJsonResult<T>> {
  const client = o.client ?? new Anthropic();
  const model = o.model ?? DEFAULT_MODEL;
  const maxTokens = o.maxTokens ?? 16000;
  const params = {
    model,
    max_tokens: maxTokens,
    // A safety-classifier decline is retried server-side on a suitable model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
    system: o.system,
    messages: [{ role: 'user' as const, content: o.prompt }],
    output_config: { effort: o.effort ?? 'medium', format: { type: 'json_schema' as const, schema: o.schema } },
  };
  // Long outputs stream (no HTTP timeout); short ones are a plain request.
  const msg = maxTokens > 16000
    ? await client.beta.messages.stream(params).finalMessage()
    : await client.beta.messages.create(params);

  const usage: Usage = {
    tokensIn: msg.usage.input_tokens ?? 0,
    tokensOut: msg.usage.output_tokens ?? 0,
    cacheRead: msg.usage.cache_read_input_tokens ?? 0,
    cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
  };
  const served = msg.model || model;
  if (msg.stop_reason === 'refusal') throw new AiError('The model declined this request.', 'refusal', usage, served);
  if (msg.stop_reason === 'max_tokens') throw new AiError(`The reply hit max_tokens (${maxTokens}) and was cut off.`, 'truncated', usage, served);
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    return { data: JSON.parse(text) as T, usage, costMicros: costMicros(served, usage), model: served };
  } catch {
    throw new AiError('The reply was not valid JSON.', 'invalid_json', usage, served);
  }
}
