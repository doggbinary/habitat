/**
 * Vision model access. Every reply comes from a real provider call; there is
 * no offline stand-in. Three ways to reach one:
 *
 *  - In the app with a key saved in Settings: the browser calls the provider.
 *  - In the app from `npm run dev` or `npm run full` with a key in the
 *    server's environment: the browser calls `/api/vision`, and the local
 *    server adds the key, so it never reaches the page.
 *  - In Node (tests, scripts): `configFromEnv(process.env)`.
 */
export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'openai-compatible';

export const PROVIDERS: { id: ProviderId; label: string; keyEnv: string[] }[] = [
  { id: 'openai', label: 'OpenAI', keyEnv: ['OPENAI_API_KEY'] },
  { id: 'anthropic', label: 'Anthropic', keyEnv: ['ANTHROPIC_API_KEY'] },
  { id: 'gemini', label: 'Google Gemini', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', keyEnv: ['HABITAT_VISION_API_KEY'] },
];

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: 'gpt-4.1',
  anthropic: 'claude-sonnet-4-5',
  gemini: 'gemini-2.5-pro',
  'openai-compatible': '',
};

const BASE_URLS: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  'openai-compatible': '',
};

export interface VisionConfig {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Send requests to the local server's `/api/vision`, which holds the key. */
  proxyUrl?: string;
}

export interface VisionImage {
  /** Said to the model just before the picture, so several pictures can be told apart. */
  label: string;
  png: Uint8Array;
}

export interface VisionRequest {
  system: string;
  prompt: string;
  images: VisionImage[];
  maxTokens?: number;
}

export type VisionErrorCode = 'no-key' | 'config' | 'auth' | 'http' | 'network' | 'empty';

export class VisionError extends Error {
  constructor(
    message: string,
    readonly code: VisionErrorCode,
  ) {
    super(message);
  }
}

export const NO_KEY_MESSAGE =
  'No vision model is configured, so AI Extract cannot look at the sheet. Add an API key in AI Extract settings, ' +
  'or start the app with OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY set (optionally HABITAT_VISION_PROVIDER ' +
  'and HABITAT_VISION_MODEL).';

export function describeConfig(config: VisionConfig): string {
  const label = PROVIDERS.find((p) => p.id === config.provider)?.label ?? config.provider;
  return `${label} ${config.model}`;
}

/**
 * The provider named by HABITAT_VISION_PROVIDER, or the first one with a key.
 * Throws a VisionError with code `no-key` when nothing usable is set.
 */
export function configFromEnv(env: Record<string, string | undefined>): VisionConfig {
  const wanted = env.HABITAT_VISION_PROVIDER?.trim() as ProviderId | undefined;
  if (wanted && !PROVIDERS.some((p) => p.id === wanted)) {
    throw new VisionError(
      `HABITAT_VISION_PROVIDER must be one of ${PROVIDERS.map((p) => p.id).join(', ')}, not "${wanted}".`,
      'config',
    );
  }
  const keyFor = (id: ProviderId) => {
    if (env.HABITAT_VISION_API_KEY?.trim()) return env.HABITAT_VISION_API_KEY.trim();
    for (const name of PROVIDERS.find((p) => p.id === id)!.keyEnv) if (env[name]?.trim()) return env[name]!.trim();
    return '';
  };
  const provider = wanted ?? PROVIDERS.map((p) => p.id).find((id) => keyFor(id));
  if (!provider || !keyFor(provider)) throw new VisionError(NO_KEY_MESSAGE, 'no-key');
  const model = env.HABITAT_VISION_MODEL?.trim() || DEFAULT_MODELS[provider];
  const baseUrl = env.HABITAT_VISION_BASE_URL?.trim() || undefined;
  if (!model) throw new VisionError('Set HABITAT_VISION_MODEL for an OpenAI-compatible endpoint.', 'config');
  if (provider === 'openai-compatible' && !baseUrl) {
    throw new VisionError('Set HABITAT_VISION_BASE_URL for an OpenAI-compatible endpoint.', 'config');
  }
  return { provider, model, apiKey: keyFor(provider), baseUrl };
}

type Fetch = typeof fetch;

export interface VisionClient {
  readonly label: string;
  complete(request: VisionRequest): Promise<string>;
}

export function createVisionClient(config: VisionConfig, fetchImpl: Fetch = (...a) => fetch(...a)): VisionClient {
  if (!config.proxyUrl && !config.apiKey) throw new VisionError(NO_KEY_MESSAGE, 'no-key');
  if (!config.model) throw new VisionError('Choose a model for AI Extract.', 'config');
  return {
    label: describeConfig(config),
    complete: (request) => withRetries(() => send(config, request, fetchImpl)),
  };
}

async function withRetries(run: () => Promise<string>): Promise<string> {
  let wait = 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const retryable = error instanceof RetryableError;
      if (!retryable || attempt >= 2) throw retryable ? error.inner : error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait *= 2;
    }
  }
}

class RetryableError extends Error {
  constructor(readonly inner: VisionError) {
    super(inner.message);
  }
}

/** The JSON body a provider expects, plus where to send it. */
export function buildRequest(config: VisionConfig, request: VisionRequest): { url: string; headers: Record<string, string>; body: unknown } {
  const maxTokens = request.maxTokens ?? 8192;
  const base = (config.baseUrl || BASE_URLS[config.provider]).replace(/\/+$/, '');
  const key = config.apiKey ?? '';
  const images = request.images.map((img) => ({ label: img.label, data: bytesToBase64(img.png) }));

  if (config.provider === 'anthropic') {
    return {
      url: `${base}/messages`,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Keys typed into the app are the user's own, used from their own browser.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model: config.model,
        max_tokens: maxTokens,
        temperature: 0,
        system: request.system,
        messages: [
          {
            role: 'user',
            content: [
              ...images.flatMap((img) => [
                { type: 'text', text: img.label },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data } },
              ]),
              { type: 'text', text: request.prompt },
            ],
          },
        ],
      },
    };
  }

  if (config.provider === 'gemini') {
    return {
      url: `${base}/models/${encodeURIComponent(config.model)}:generateContent`,
      headers: { 'x-goog-api-key': key },
      body: {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [
          {
            role: 'user',
            parts: [
              ...images.flatMap((img) => [{ text: img.label }, { inlineData: { mimeType: 'image/png', data: img.data } }]),
              { text: request.prompt },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: maxTokens },
      },
    };
  }

  return {
    url: `${base}/chat/completions`,
    headers: { authorization: `Bearer ${key}` },
    body: {
      model: config.model,
      // Newer reasoning models reject a temperature, so the default is left alone.
      max_completion_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: request.system },
        {
          role: 'user',
          content: [
            ...images.flatMap((img) => [
              { type: 'text', text: img.label },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${img.data}`, detail: 'high' } },
            ]),
            { type: 'text', text: request.prompt },
          ],
        },
      ],
    },
  };
}

/** The reply text out of a provider's response body. */
export function replyText(provider: ProviderId, body: unknown): string {
  const b = body as Record<string, any> | null;
  if (!b) return '';
  if (provider === 'anthropic') {
    return Array.isArray(b.content) ? b.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('') : '';
  }
  if (provider === 'gemini') {
    const parts = b.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) ? parts.map((p: any) => p?.text ?? '').join('') : '';
  }
  const content = b.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('') : '';
}

async function send(config: VisionConfig, request: VisionRequest, fetchImpl: Fetch): Promise<string> {
  let response: Response;
  try {
    if (config.proxyUrl) {
      response = await fetchImpl(config.proxyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: config.provider,
          model: config.model,
          request: { ...request, images: request.images.map((img) => ({ label: img.label, png: bytesToBase64(img.png) })) },
        }),
      });
    } else {
      const { url, headers, body } = buildRequest(config, request);
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    }
  } catch {
    throw new VisionError(`Could not reach ${describeConfig(config)}. Check the connection.`, 'network');
  }

  const body = (await response.json().catch(() => null)) as Record<string, any> | null;
  const detail = body?.error?.message ?? body?.error ?? '';
  if (response.status === 401 || response.status === 403) {
    throw new VisionError(`${describeConfig(config)} rejected the API key${detail ? `: ${detail}` : ''}.`, 'auth');
  }
  if (response.status === 503 && body?.code === 'no-key') throw new VisionError(NO_KEY_MESSAGE, 'no-key');
  if (response.status === 429 || response.status >= 500) {
    throw new RetryableError(new VisionError(`${describeConfig(config)} failed (${response.status}) ${detail}`.trim(), 'http'));
  }
  if (!response.ok) throw new VisionError(`${describeConfig(config)} failed (${response.status}) ${detail}`.trim(), 'http');
  const text = config.proxyUrl ? String(body?.text ?? '') : replyText(config.provider, body);
  if (!text.trim()) throw new VisionError(`${describeConfig(config)} sent an empty reply.`, 'empty');
  return text;
}

/** The first JSON object in a reply, tolerating code fences and stray prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
