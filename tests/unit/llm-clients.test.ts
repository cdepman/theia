import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicCall } from '../../pipeline/llm/anthropic';
import { createLlmRouter } from '../../pipeline/llm/client';
import { openaiCall } from '../../pipeline/llm/openai';
import type { LlmCallEvent, LlmRequest } from '../../pipeline/llm/types';

const request: LlmRequest = {
  model: 'gpt-6-luna', system: 'Group these headlines.', user: 'A bridge opens.', maxTokens: 500,
  schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
};
const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
const answer = (overrides: Record<string, unknown> = {}) => ({
  status: 'completed',
  output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: '{"label":"Bridge opening"}' }] }],
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe('OpenAI structured-output adapter', () => {
  it('sends the shared prompt/schema through Responses and reads text after reasoning output', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(answer()));
    const result = await openaiCall('test-key', { fetchImpl, reasoningEffort: 'low' })(request);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init!.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: request.model, instructions: request.system, input: [{ role: 'user', content: request.user }],
      store: false, service_tier: 'default', max_output_tokens: 500, reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'theia_grouping', strict: true, schema: request.schema } },
    });
    expect(result).toMatchObject({ input: { label: 'Bridge opening' }, usage: {
      model: request.model, provider: 'openai', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40,
    } });
  });

  it('records usage and request IDs even when a paid response is incomplete', async () => {
    const events: LlmCallEvent[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(answer({
      id: 'resp-1', model: 'gpt-6-luna', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: {
        cached_tokens: 40, cache_write_tokens: 15, cache_write_tokens_details: { ttl_30m_tokens: 10, ttl_12h_tokens: 5 },
      }, output_tokens_details: { reasoning_tokens: 12 } },
    }), 200, { 'x-request-id': 'req-1' }));
    await expect(openaiCall('secret', { fetchImpl, onCall: (event) => events.push(event) })(request)).rejects.toThrow(/max_output_tokens/);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'start', model: 'openai:gpt-6-luna', attempt: 1 });
    expect(events[1]).toMatchObject({ type: 'finish', id: events[0]!.id, outcome: 'failed', requestId: 'req-1', responseId: 'resp-1',
      usage: { model: 'openai:gpt-6-luna', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40,
        cacheWriteInputTokens: 15, cacheWriteShortInputTokens: 10, cacheWriteLongInputTokens: 5, reasoningOutputTokens: 12 } });
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(JSON.stringify(events)).not.toContain(request.user);
  });

  it('stops spending if logging fails before a request or after its response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(answer()));
    await expect(openaiCall('key', { fetchImpl, onCall: () => { throw new Error('Disk full'); } })(request)).rejects.toThrow('Disk full');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(openaiCall('key', { fetchImpl, onCall: (event) => {
      if (event.type === 'finish') throw new Error('Disk full');
    } })(request)).rejects.toThrow('Disk full');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('omits reasoning when the provider default is selected', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(answer()));
    await openaiCall('key', { fetchImpl })({ ...request, model: 'other-model' });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).not.toHaveProperty('reasoning');
  });

  it.each([
    ['incomplete output', answer({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), /max_output_tokens/],
    ['failed response', answer({ status: 'failed' }), /failed/],
    ['refusal', answer({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }), /declined/],
    ['missing text', answer({ output: [{ type: 'reasoning' }] }), /no structured answer/],
    ['invalid JSON', answer({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'oops' }] }] }), /not valid JSON/],
    ['null JSON', answer({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'null' }] }] }), /not a JSON object/],
    ['missing usage', answer({ usage: undefined }), /token usage/],
  ])('rejects %s instead of saving a successful trial', async (_name, body, message) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    await expect(openaiCall('key', { fetchImpl })(request)).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403])('does not retry HTTP %s', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { message: 'test-key' } }, status));
    await expect(openaiCall('test-key', { fetchImpl })(request)).rejects.toThrow(`OpenAI API ${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries rate limits and transient server failures, respecting Retry-After', async () => {
    vi.useFakeTimers();
    const events: LlmCallEvent[] = [];
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '5' }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json(answer()));
    const pending = openaiCall('key', { fetchImpl, onCall: (event) => events.push(event) })(request);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ input: { label: 'Bridge opening' } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === 'start').map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(events.filter((e) => e.type === 'finish').map((e) => e.httpStatus)).toEqual([429, 503, 200]);
    expect(events.filter((e) => e.type === 'finish').slice(0, 2).every((e) => e.usage === null)).toBe(true);
  });

  it('stops after four failed attempts', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 503));
    const pending = openaiCall('key', { fetchImpl })(request).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ message: 'OpenAI API 503' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('times out stalled bodies as well as the initial fetch', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))); },
    })));
    const pending = openaiCall('key', { fetchImpl, timeoutMs: 10 })(request).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ message: 'OpenAI request timed out after 10 ms' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('provider routing', () => {
  it('can route primary and escalation to different providers without leaking credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(answer()))
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: '{"label":"Bridge opening"}' }], usage: { input_tokens: 80, output_tokens: 10 }, stop_reason: 'end_turn' }));
    const llm = createLlmRouter([
      { provider: 'openai', model: 'gpt-6-luna' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    ], { OPENAI_API_KEY: 'openai-key', ANTHROPIC_API_KEY: 'anthropic-key' }, { fetchImpl });
    expect((await llm({ ...request, model: 'openai:gpt-6-luna' })).usage.model).toBe('openai:gpt-6-luna');
    expect((await llm({ ...request, model: 'anthropic:claude-sonnet-5-5' })).usage.model).toBe('anthropic:claude-sonnet-5-5');
    expect(fetchImpl.mock.calls[0]![1]!.headers).not.toHaveProperty('x-api-key');
    expect(fetchImpl.mock.calls[1]![1]!.headers).toMatchObject({ 'x-api-key': 'anthropic-key' });
    expect(fetchImpl.mock.calls[1]![1]!.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string).model).toBe('claude-sonnet-5-5');
    await expect(llm({ ...request, model: 'openai:unconfigured' })).rejects.toThrow(/not configured/);
  });

  it('checks all selected keys before a primary request can incur cost', () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createLlmRouter([
      { provider: 'anthropic', model: 'claude-haiku-5-5' }, { provider: 'openai', model: 'gpt-6-luna' },
    ], { ANTHROPIC_API_KEY: 'key' }, { fetchImpl })).toThrow('OPENAI_API_KEY is not set');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => createLlmRouter([{ provider: 'openai', model: 'gpt-6-luna' }], { OPENAI_API_KEY: 'key' })).not.toThrow();
  });

  it('preserves Anthropic structured requests and normalizes cache usage', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({
      content: [{ type: 'text', text: '{"label":"Bridge opening"}' }], stop_reason: 'end_turn',
      usage: { input_tokens: 80, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 } },
    }));
    const result = await anthropicCall('key', fetchImpl)({ ...request, model: 'claude-haiku-5-5' });
    expect(result.usage).toMatchObject({ inputTokens: 105, cachedInputTokens: 20, cacheWriteInputTokens: 5,
      cacheWriteShortInputTokens: 3, cacheWriteLongInputTokens: 2, outputTokens: 10 });
    expect(result.usage.reasoningOutputTokens).toBeUndefined();
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).output_config.format.schema).toEqual(request.schema);
  });

  it('retains Anthropic usage when output runs out, instead of recording a free failure', async () => {
    const events: LlmCallEvent[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 'msg-1', stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 500 } }, 200, { 'request-id': 'req-2' }));
    await expect(anthropicCall('key', fetchImpl, 120_000, (event) => events.push(event))({ ...request, model: 'claude-haiku-5-5' })).rejects.toThrow(/ran out/);
    expect(events[1]).toMatchObject({ type: 'finish', outcome: 'failed', requestId: 'req-2', responseId: 'msg-1',
      usage: { model: 'anthropic:claude-haiku-5-5', inputTokens: 100, outputTokens: 500 } });
  });

  it('can bound Claude review effort without changing the initial grouper default', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({ content: [{ type: 'text', text: '{"label":"Bridge opening"}' }],
      stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }));
    await anthropicCall('key', fetchImpl)({ ...request, model: 'claude-haiku-5-5' });
    await anthropicCall('key', fetchImpl, 120_000, undefined, 'low')({ ...request, model: 'claude-haiku-5-5' });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).output_config).not.toHaveProperty('effort');
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string).output_config.effort).toBe('low');
  });
});
