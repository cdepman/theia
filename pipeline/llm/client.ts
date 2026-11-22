import { anthropicCall } from './anthropic';
import { openaiCall } from './openai';
import { LlmError, type AnthropicEffort, type LlmCall, type LlmCallObserver, type LlmProvider, type ReasoningEffort } from './types';

export interface ModelTarget { provider: LlmProvider; model: string }

export const DEFAULT_MODELS: Record<LlmProvider, { primary: string; review: string }> = {
  anthropic: { primary: 'claude-haiku-5-5', review: 'claude-sonnet-5-5' },
  openai: { primary: 'gpt-6-luna', review: 'gpt-6.2-sol' },
};

export function modelRef(target: ModelTarget): string { return `${target.provider}:${target.model}`; }

/** Explicit routing: an API failure never silently switches providers or models. */
export function createLlmRouter(targets: ModelTarget[], env: Record<string, string | undefined>, opts: {
  fetchImpl?: typeof fetch; timeoutMs?: number; reasoningEffort?: ReasoningEffort;
  onCall?: LlmCallObserver;
  anthropicEffort?: AnthropicEffort;
} = {}): LlmCall {
  const clients = new Map<LlmProvider, LlmCall>();
  const byRef = new Map(targets.map((target) => [modelRef(target), target]));
  // Validate every selected credential before spending on the first stage.
  for (const { provider } of targets) {
    if (clients.has(provider)) continue;
    if (provider === 'anthropic') clients.set(provider, anthropicCall(env.ANTHROPIC_API_KEY?.trim() ?? '', opts.fetchImpl, opts.timeoutMs, opts.onCall, opts.anthropicEffort));
    else if (provider === 'openai') clients.set(provider, openaiCall(env.OPENAI_API_KEY?.trim() ?? '', opts));
    else throw new LlmError(`Unsupported LLM provider: ${provider}`);
  }
  return async (req) => {
    const target = byRef.get(req.model);
    if (!target) throw new LlmError(`Model is not configured: ${req.model}`);
    const response = await clients.get(target.provider)!({ ...req, model: target.model });
    return { ...response, usage: { ...response.usage, provider: target.provider, model: req.model } };
  };
}
