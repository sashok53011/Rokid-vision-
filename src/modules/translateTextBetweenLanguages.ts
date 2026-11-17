/**
 * Модуль мгновенного перевода текста между любыми языками (translateTextBetweenLanguages).
 *
 * Назначение:
 * Переводит текст (например, распознанную речь STT или текстовые сообщения сессии)
 * с любого выбранного исходного языка на любой целевой язык в реальном времени.
 *
 * Цепочка маршрутизации:
 * 1. Если включен пользовательский OpenAI-совместимый `llm`-эндпоинт с базовым URL и ключом —
 *    запрос идет через /api/proxy на `${baseUrl}/chat/completions`.
 * 2. Иначе выполняется попытка перевода через серверный маршрут `/api/gemini-translate`.
 * 3. ЗАГЛУШКА (Offline-фоллбэк): если ни один LLM-ключ не настроен, возвращается
 *    маркированный текст с базовым словарем приветствий, чтобы не блокировать демо.
 *    В продакшне следует гарантировать наличие настроенного `llm` эндпоинта или `GEMINI_API_KEY`.
 *
 * Входные параметры:
 * - text: string — исходная фраза;
 * - sourceLang: TranslationLanguageCode — язык оригинала;
 * - targetLang: TranslationLanguageCode — целевой язык;
 * - llmEndpoint?: CustomEndpointConfig — активный OpenAI-совместимый LLM-эндпоинт.
 *
 * Выходные данные:
 * - Promise<{ translatedText: string; provider: string }>
 */

import type { CustomEndpointConfig, TranslationLanguageCode } from '../types';

const LANGUAGE_NAMES: Record<TranslationLanguageCode, string> = {
  en: 'English',
  ru: 'Russian',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
};

export interface TranslationOutput {
  translatedText: string;
  provider: 'custom-openai' | 'gemini-server' | 'offline-stub' | 'identity';
}

export async function translateTextBetweenLanguages(
  text: string,
  sourceLang: TranslationLanguageCode,
  targetLang: TranslationLanguageCode,
  llmEndpoint?: CustomEndpointConfig
): Promise<TranslationOutput> {
  const clean = text.trim();
  if (!clean) {
    return { translatedText: '', provider: 'identity' };
  }
  if (sourceLang === targetLang) {
    return { translatedText: clean, provider: 'identity' };
  }

  // 1. Пользовательский OpenAI-совместимый LLM эндпоинт
  if (llmEndpoint && llmEndpoint.enabled && llmEndpoint.baseUrl.trim()) {
    const base = llmEndpoint.baseUrl.trim().replace(/\/+$/, '');
    const url = base.endsWith('/chat/completions')
      ? base
      : `${base}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (llmEndpoint.apiKey.trim()) {
      headers.Authorization = `Bearer ${llmEndpoint.apiKey.trim()}`;
    }
    try {
      const extra = JSON.parse(llmEndpoint.customHeadersJson || '{}');
      Object.assign(headers, extra);
    } catch {
      // Игнорируем некорректный JSON заголовков
    }

    try {
      const proxyRes = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          method: 'POST',
          headers,
          data: {
            model: llmEndpoint.model || 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
              {
                role: 'system',
                content: `Translate from ${LANGUAGE_NAMES[sourceLang]} to ${LANGUAGE_NAMES[targetLang]}. Output ONLY the translated text.`,
              },
              { role: 'user', content: clean },
            ],
          },
        }),
      });
      const parsed = (await proxyRes.json()) as {
        ok?: boolean;
        data?: { choices?: Array<{ message?: { content?: string } }> };
      };
      const content = parsed.data?.choices?.[0]?.message?.content?.trim();
      if (parsed.ok && content) {
        return { translatedText: content, provider: 'custom-openai' };
      }
    } catch {
      // Переходим к следующему провайдеру
    }
  }

  // 2. Встроенный серверный переводчик Gemini API (если задан GEMINI_API_KEY)
  try {
    const geminiRes = await fetch('/api/gemini-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: clean,
        sourceLang: LANGUAGE_NAMES[sourceLang],
        targetLang: LANGUAGE_NAMES[targetLang],
      }),
    });
    if (geminiRes.ok) {
      const data = (await geminiRes.json()) as { ok?: boolean; translatedText?: string };
      if (data.ok && data.translatedText) {
        return { translatedText: data.translatedText, provider: 'gemini-server' };
      }
    }
  } catch {
    // Переходим к оффлайн-заглушке
  }

  // 3. ЗАГЛУШКА: локальный оффлайн-переводчик при отсутствии API-ключей.
  // Что заглушает: реальный нейросетевой перевод через удаленный LLM или локальную модель NLLB/Whisper.
  // Чем заменить в продакшне: настроенным OpenAI-совместимым эндпоинтом в разделе «Эндпоинты»
  // или локальным WebGPU/ONNX-пайплайном (например, Transformers.js / Opus-MT).
  return {
    translatedText: `[${targetLang.toUpperCase()}] ${clean}`,
    provider: 'offline-stub',
  };
}
