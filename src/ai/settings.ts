import { DEFAULT_MODELS, PROVIDERS, type ProviderId, type VisionConfig } from './vision';

/**
 * Where AI Extract gets its model in the app. A key typed into Settings
 * stays in this browser's storage and is sent only to the chosen provider.
 * Without one, the local server (`npm run dev` / `npm run full`) is asked:
 * it holds keys from its own environment and passes requests on, so the
 * key never reaches the page.
 */
const STORAGE_KEY = 'habitat-vision-settings';

export interface VisionSettings {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
}

const isProvider = (v: unknown): v is ProviderId => PROVIDERS.some((p) => p.id === v);

/** Build-time defaults for the form; keys are never baked into the build. */
function buildDefaults(): { provider: ProviderId; model: string } {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const provider = isProvider(env.VITE_VISION_PROVIDER) ? env.VITE_VISION_PROVIDER : 'openai';
  return { provider, model: env.VITE_VISION_MODEL || DEFAULT_MODELS[provider] };
}

export function loadVisionSettings(): VisionSettings {
  const defaults = buildDefaults();
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<VisionSettings> | null;
    if (raw && isProvider(raw.provider)) {
      return {
        provider: raw.provider,
        model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_MODELS[raw.provider],
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      };
    }
  } catch {
    /* unreadable settings fall back to the defaults */
  }
  return { ...defaults, apiKey: '', baseUrl: '' };
}

export function saveVisionSettings(settings: VisionSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, apiKey: settings.apiKey.trim(), model: settings.model.trim(), baseUrl: settings.baseUrl.trim() }));
}

export interface ServerVision {
  available: boolean;
  provider?: ProviderId;
  model?: string;
  error?: string;
}

/** What the local server can do, or null when there is no such server (the website, the iPad app). */
export async function serverVision(): Promise<ServerVision | null> {
  try {
    const response = await fetch(new URL('api/vision/status', document.baseURI), { cache: 'no-cache' });
    if (!response.ok) return null;
    const body = (await response.json()) as ServerVision;
    return typeof body?.available === 'boolean' ? body : null;
  } catch {
    return null;
  }
}

export interface ResolvedVision {
  config: VisionConfig;
  where: 'browser' | 'server';
}

/** The model to use right now, or null when none is configured anywhere. */
export async function resolveVision(): Promise<{ resolved: ResolvedVision | null; server: ServerVision | null }> {
  const settings = loadVisionSettings();
  const server = await serverVision();
  if (settings.apiKey) {
    return {
      resolved: {
        config: { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, baseUrl: settings.baseUrl || undefined },
        where: 'browser',
      },
      server,
    };
  }
  if (server?.available && server.provider && server.model) {
    return {
      resolved: {
        config: { provider: server.provider, model: server.model, proxyUrl: new URL('api/vision/complete', document.baseURI).href },
        where: 'server',
      },
      server,
    };
  }
  return { resolved: null, server };
}
