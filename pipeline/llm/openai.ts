import { startCall } from './accounting';
import { LlmError, type LlmCall, type LlmCallObserver, type ReasoningEffort } from './types';

interface OpenAIResponse {
  id?: string;
  model?: string;
  service_tier?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: {
    input_tokens: number; output_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_write_tokens_details?: { ttl_30m_tokens?: number; ttl_12h_tokens?: number } };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface OpenAIOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  onCall?: LlmCallObserver;
}

/** Responses API with strict JSON output. The timeout covers headers AND the body. */
export function openaiCall(apiKey: string, opts: OpenAIOptions = {}): LlmCall {
  if (!apiKey.trim()) throw new LlmError('OPENAI_API_KEY is not set');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return async (req) => {
    const body = JSON.stringify({
      model: req.model,
      instructions: req.system,
      input: [{ role: 'user', content: req.user }],
      max_output_tokens: req.maxTokens ?? 16000,
      store: false,
      service_tier: 'default',
      ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
      text: { format: { type: 'json_schema', name: 'theia_grouping', strict: true, schema: req.schema } },
    });
    let lastError = new LlmError('no attempt made');
    let retryAfterMs = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.max(1500 * 2 ** (attempt - 1), retryAfterMs)));
      const call = startCall('openai', req.model, attempt + 1, opts.onCall);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST', body, signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        });
        call.result.httpStatus = res.status;
        call.result.requestId = res.headers.get('x-request-id');
        if (!res.ok) {
          // Never include the key, input headlines, or arbitrary upstream response text in logs.
          lastError = new LlmError(`OpenAI API ${res.status}`, res.status);
          const retry = res.headers.get('retry-after');
          retryAfterMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(Date.parse(retry) - Date.now(), 0)) : 0;
          if (!Number.isFinite(retryAfterMs)) retryAfterMs = 0;
          await res.body?.cancel();
          // Respect long Retry-After values by stopping, rather than retrying early.
          if ((res.status === 429 || res.status >= 500) && retryAfterMs <= 60_000) continue;
          throw lastError;
        }
        const data = await res.json() as OpenAIResponse;
        call.result.responseId = data.id ?? null;
        const usage = data.usage;
        // Even an incomplete/refused/malformed answer can incur a charge.
        if (usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
          call.result.usage = {
            provider: 'openai', model: req.model, responseModel: data.model, serviceTier: data.service_tier ?? 'default',
            inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
            cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
            cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
            cacheWriteShortInputTokens: usage.input_tokens_details?.cache_write_tokens_details?.ttl_30m_tokens ?? 0,
            cacheWriteLongInputTokens: usage.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens ?? 0,
            reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens,
          };
        }
        if (data.status !== 'completed') {
          throw new LlmError(`OpenAI response ${data.status ?? 'missing status'}${data.incomplete_details?.reason ? `: ${data.incomplete_details.reason}` : ''}`);
        }
        const content = (data.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []);
        if (content.some((part) => part.type === 'refusal')) throw new LlmError('OpenAI declined to produce the requested structured answer');
        const text = content.filter((part) => part.type === 'output_text').map((part) => part.text ?? '').join('');
        if (!text) throw new LlmError('OpenAI returned no structured answer');
        let input: unknown;
        try { input = JSON.parse(text); } catch { throw new LlmError('OpenAI answer was not valid JSON'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LlmError('OpenAI answer was not a JSON object');
        if (!call.result.usage) {
          throw new LlmError('OpenAI response did not include token usage');
        }
        call.result.outcome = 'success';
        return { input, usage: call.result.usage };
      } catch (e) {
        if (e instanceof LlmError) throw e;
        lastError = new LlmError(controller.signal.aborted ? `OpenAI request timed out after ${timeoutMs} ms` : 'OpenAI request failed while reading the response');
      } finally {
        clearTimeout(timer);
        call.finish();
      }
    }
    throw lastError;
  };
}
