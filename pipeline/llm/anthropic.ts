// Minimal Anthropic Messages client: one request, answered as JSON that matches a schema
// (structured outputs). Forced tool calls are not used: the larger current models reject them.
// No SDK, so it runs anywhere fetch exists (Netlify functions, the CLI, plain Node).

import { startCall } from './accounting';
import { LlmError, type AnthropicEffort, type LlmCall, type LlmCallObserver } from './types';
export { LlmError, type LlmCall, type LlmUsage, type LlmToolRequest } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function anthropicCall(apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 120_000, onCall?: LlmCallObserver, effort?: AnthropicEffort): LlmCall {
  if (!apiKey) throw new LlmError('ANTHROPIC_API_KEY is not set');
  return async (req) => {
    const body = JSON.stringify({
      model: req.model,
      service_tier: 'standard_only',
      // Current models think before answering by default, and thinking counts toward this limit.
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema: req.schema } },
    });
    let lastError: LlmError = new LlmError('no attempt made');
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(1500 * 2 ** (attempt - 1));
      const call = startCall('anthropic', req.model, attempt + 1, onCall);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' },
          body,
          signal: controller.signal,
        });
        call.result.httpStatus = res.status;
        call.result.requestId = res.headers.get('request-id');
        if (!res.ok) {
          await res.body?.cancel();
          lastError = new LlmError(`Anthropic API ${res.status}`, res.status);
          // Rate limits and overload are worth retrying; a bad request or bad key is not.
          if (res.status === 429 || res.status >= 500) continue;
          throw lastError;
        }
        const data = (await res.json()) as {
          id?: string; model?: string;
          content?: { type: string; text?: string }[];
          usage?: {
            input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
            cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }; service_tier?: string;
          };
          stop_reason?: string;
        };
        call.result.responseId = data.id ?? null;
        const usage = data.usage;
        if (usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
          call.result.usage = {
            provider: 'anthropic', model: req.model, responseModel: data.model, serviceTier: usage.service_tier ?? 'standard',
            inputTokens: usage.input_tokens! + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            outputTokens: usage.output_tokens!, cachedInputTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0,
            cacheWriteShortInputTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
            cacheWriteLongInputTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          };
        }
        if (data.stop_reason === 'max_tokens') throw new LlmError('The model ran out of output tokens before finishing');
        const block = data.content?.find((c) => c.type === 'text' && typeof c.text === 'string');
        if (!block) throw new LlmError(`The model returned no answer (stop reason ${data.stop_reason ?? 'unknown'})`);
        let input: unknown;
        try {
          input = JSON.parse(block.text!);
        } catch {
          throw new LlmError('The model answer was not valid JSON');
        }
        if (!call.result.usage) throw new LlmError('Anthropic response did not include token usage');
        call.result.outcome = 'success';
        return { input, usage: call.result.usage };
      } catch (e) {
        if (e instanceof LlmError) throw e;
        lastError = new LlmError(controller.signal.aborted ? `Timed out after ${timeoutMs} ms` : 'Anthropic request failed while reading the response');
      } finally {
        clearTimeout(timer);
        call.finish();
      }
    }
    throw lastError;
  };
}
