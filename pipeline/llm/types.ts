export type LlmProvider = 'anthropic' | 'openai';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmUsage {
  model: string;
  provider?: LlmProvider;
  inputTokens: number;
  outputTokens: number;
  /** Included in inputTokens, not additional tokens. */
  cachedInputTokens?: number;
  /** Included in inputTokens. Kept separately because cache writes have their own price. */
  cacheWriteInputTokens?: number;
  /** Provider's short/long cache retention: OpenAI 30m/12h, Anthropic 5m/1h. */
  cacheWriteShortInputTokens?: number;
  cacheWriteLongInputTokens?: number;
  /** Included in outputTokens. Omitted when the provider does not report it. */
  reasoningOutputTokens?: number;
  responseModel?: string;
  serviceTier?: string;
}

export interface LlmCallStart {
  type: 'start'; id: string; provider: LlmProvider; model: string; attempt: number; startedAt: string;
}
export interface LlmCallFinish {
  type: 'finish'; id: string; finishedAt: string; durationMs: number;
  httpStatus: number | null; requestId: string | null; responseId: string | null;
  outcome: 'success' | 'failed'; usage: LlmUsage | null;
}
export type LlmCallEvent = LlmCallStart | LlmCallFinish;
export type LlmCallObserver = (event: LlmCallEvent) => void;

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  /** All object properties must be required, with additionalProperties: false. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

// Compatibility with the original grouper's name; both providers use structured JSON.
export type LlmToolRequest = LlmRequest;
export type LlmCall = (req: LlmRequest) => Promise<{ input: unknown; usage: LlmUsage }>;

export class LlmError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'LlmError';
  }
}
