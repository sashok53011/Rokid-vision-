/**
 * Модуль управления пользовательскими OpenAI-совместимыми, RTC и Cloud эндпоинтами (manageCustomEndpoints).
 *
 * Назначение:
 * Позволяет пользователю добавлять, редактировать, удалять (по одному или все сразу),
 * включать/выключать неограниченное количество эндпоинтов всех типов:
 * - llm (OpenAI-совместимый чат/перевод /v1/chat/completions)
 * - stt (распознавание речи /v1/audio/transcriptions)
 * - tts (синтез речи /v1/audio/speech)
 * - vision (мультимодальный анализ кадра)
 * - rtc (WebRTC сигналинг / OpenAI Realtime API wss://)
 * - cloud_render (удаленный сервер облачного 3D-рендеринга)
 * Также включает функции тестирования соединения и загрузки списка моделей (/v1/models).
 *
 * Входные параметры:
 * - Массив CustomEndpointConfig (загружается из localStorage или DEFAULT_ENDPOINTS).
 *
 * Выходные данные:
 * - Реактивное хранилище эндпоинтов, результаты проверки соединения и списки моделей.
 */

import { DEFAULT_ENDPOINTS, STORAGE_KEYS } from '../constants';
import type { CustomEndpointConfig, EndpointCategory } from '../types';

export interface EndpointTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export interface EndpointManager {
  getAll(): CustomEndpointConfig[];
  getActiveByType(type: EndpointCategory): CustomEndpointConfig | undefined;
  upsert(endpoint: CustomEndpointConfig): CustomEndpointConfig[];
  remove(id: string): CustomEndpointConfig[];
  removeAll(): CustomEndpointConfig[];
  testConnection(id: string): Promise<EndpointTestResult>;
  fetchModels(id: string): Promise<string[]>;
  subscribe(listener: (endpoints: CustomEndpointConfig[]) => void): () => void;
}

function parseHeaders(jsonStr: string): Record<string, string> {
  try {
    const parsed = JSON.parse(jsonStr || '{}');
    if (parsed && typeof parsed === 'object') {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') result[k] = v;
      }
      return result;
    }
  } catch {
    // Некорректный JSON заголовков игнорируется
  }
  return {};
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Создает менеджер управления пользовательскими эндпоинтами с сохранением в localStorage.
 */
export function createEndpointManager(): EndpointManager {
  let endpoints: CustomEndpointConfig[] = loadInitialEndpoints();
  const listeners = new Set<(list: CustomEndpointConfig[]) => void>();

  function loadInitialEndpoints(): CustomEndpointConfig[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ENDPOINTS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as CustomEndpointConfig[];
      }
    } catch {
      // Используются стандартные шаблоны
    }
    return DEFAULT_ENDPOINTS.map((item) => ({ ...item }));
  }

  function persistAndNotify(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.ENDPOINTS, JSON.stringify(endpoints));
    } catch {
      // Игнорируем переполнение localStorage
    }
    const snapshot = endpoints.map((e) => ({ ...e }));
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  async function testConnection(id: string): Promise<EndpointTestResult> {
    const idx = endpoints.findIndex((e) => e.id === id);
    if (idx === -1) {
      return { ok: false, latencyMs: 0, message: 'Endpoint not found' };
    }
    const ep = endpoints[idx];
    const base = normalizeBaseUrl(ep.baseUrl);
    const started = performance.now();

    // Проверка WebSocket / RTC-эндпоинта (ws:// или wss://)
    if (ep.type === 'rtc' && /^wss?:\/\//i.test(base)) {
      const result = await new Promise<EndpointTestResult>((resolve) => {
        try {
          const ws = new WebSocket(base);
          const timer = window.setTimeout(() => {
            ws.close();
            resolve({
              ok: false,
              latencyMs: Math.round(performance.now() - started),
              message: 'WebSocket/RTC timeout (4000ms)',
            });
          }, 4000);
          ws.onopen = () => {
            clearTimeout(timer);
            const latencyMs = Math.round(performance.now() - started);
            ws.close();
            resolve({ ok: true, latencyMs, message: `WS/RTC open (${latencyMs} ms)` });
          };
          ws.onerror = () => {
            clearTimeout(timer);
            const latencyMs = Math.round(performance.now() - started);
            resolve({
              ok: false,
              latencyMs,
              message: 'WS handshake rejected or unreachable (check auth/URL)',
            });
          };
        } catch (err) {
          resolve({
            ok: false,
            latencyMs: 0,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });

      endpoints[idx] = {
        ...ep,
        lastTestStatus: result.ok ? 'ok' : 'error',
        lastTestMessage: result.message,
        lastLatencyMs: result.latencyMs,
      };
      persistAndNotify();
      return result;
    }

    // Проверка HTTP/HTTPS эндпоинтов через серверный прокси /api/proxy (без CORS)
    const probeUrl =
      ep.type === 'cloud_render' || !base.endsWith('/v1')
        ? base.includes('/models') || ep.type === 'cloud_render'
          ? base
          : `${base}/models`
        : `${base}/models`;

    const headers: Record<string, string> = {
      ...parseHeaders(ep.customHeadersJson),
    };
    if (ep.apiKey.trim()) {
      headers.Authorization = `Bearer ${ep.apiKey.trim()}`;
    }

    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: probeUrl,
          method: 'GET',
          headers,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        status?: number;
        latencyMs?: number;
        error?: string;
      };
      const latencyMs = json.latencyMs ?? Math.round(performance.now() - started);
      const ok = Boolean(json.ok);
      const message = ok
        ? `HTTP ${json.status} OK (${latencyMs} ms)`
        : json.error || `HTTP ${json.status ?? 'ERR'} (${latencyMs} ms)`;

      endpoints[idx] = {
        ...ep,
        lastTestStatus: ok ? 'ok' : 'error',
        lastTestMessage: message,
        lastLatencyMs: latencyMs,
      };
      persistAndNotify();
      return { ok, latencyMs, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      endpoints[idx] = {
        ...ep,
        lastTestStatus: 'error',
        lastTestMessage: message,
        lastLatencyMs: null,
      };
      persistAndNotify();
      return { ok: false, latencyMs: 0, message };
    }
  }

  async function fetchModels(id: string): Promise<string[]> {
    const idx = endpoints.findIndex((e) => e.id === id);
    if (idx === -1) return [];
    const ep = endpoints[idx];
    const base = normalizeBaseUrl(ep.baseUrl);

    if (/^wss?:\/\//i.test(base)) {
      // Для WS/RTC-эндпоинтов используем HTTPS-аналог /v1/models, если это OpenAI Realtime
      const httpModelsUrl = base.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/realtime.*$/, '/models');
      return queryModelsViaProxy(idx, ep, httpModelsUrl);
    }

    const modelsUrl = base.endsWith('/models') ? base : `${base}/models`;
    return queryModelsViaProxy(idx, ep, modelsUrl);
  }

  async function queryModelsViaProxy(
    idx: number,
    ep: CustomEndpointConfig,
    modelsUrl: string
  ): Promise<string[]> {
    const headers: Record<string, string> = {
      ...parseHeaders(ep.customHeadersJson),
    };
    if (ep.apiKey.trim()) {
      headers.Authorization = `Bearer ${ep.apiKey.trim()}`;
    }

    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: modelsUrl,
          method: 'GET',
          headers,
        }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        latencyMs?: number;
        data?: { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> };
        error?: string;
      };

      const rawList = payload.data?.data ?? payload.data?.models ?? [];
      const modelIds = rawList
        .map((item) => item.id || (item as { name?: string }).name || '')
        .filter(Boolean);

      if (modelIds.length > 0) {
        endpoints[idx] = {
          ...ep,
          availableModels: modelIds,
          model: modelIds.includes(ep.model) ? ep.model : modelIds[0],
          lastTestStatus: 'ok',
          lastTestMessage: `Loaded ${modelIds.length} models`,
          lastLatencyMs: payload.latencyMs ?? ep.lastLatencyMs,
        };
      } else {
        endpoints[idx] = {
          ...ep,
          lastTestStatus: payload.ok ? 'ok' : 'error',
          lastTestMessage: payload.ok
            ? '0 models returned in /models'
            : payload.error || 'Failed to fetch models',
        };
      }
      persistAndNotify();
      return modelIds;
    } catch (err) {
      endpoints[idx] = {
        ...ep,
        lastTestStatus: 'error',
        lastTestMessage: err instanceof Error ? err.message : String(err),
      };
      persistAndNotify();
      return [];
    }
  }

  return {
    getAll: () => endpoints.map((e) => ({ ...e })),
    getActiveByType: (type: EndpointCategory) =>
      endpoints.find((e) => e.type === type && e.enabled),
    upsert: (endpoint: CustomEndpointConfig) => {
      const idx = endpoints.findIndex((e) => e.id === endpoint.id);
      if (idx >= 0) {
        endpoints[idx] = { ...endpoint };
      } else {
        endpoints.push({ ...endpoint });
      }
      persistAndNotify();
      return endpoints.map((e) => ({ ...e }));
    },
    remove: (id: string) => {
      endpoints = endpoints.filter((e) => e.id !== id);
      persistAndNotify();
      return endpoints.map((e) => ({ ...e }));
    },
    removeAll: () => {
      endpoints = [];
      persistAndNotify();
      return [];
    },
    testConnection,
    fetchModels,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
