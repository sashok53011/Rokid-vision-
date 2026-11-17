/**
 * Модуль прямой речевой коммуникации (TTS + STT) между любыми участниками виртуальной сессии (communicatePeerTtsStt).
 *
 * Назначение:
 * Обеспечивает прямое общение "любой-к-любому" внутри комнаты WebSocket (/ws):
 * 1. Распознавание речи (STT): использует браузерный SpeechRecognition (Web Speech API)
 *    или пользовательский OpenAI-совместимый Whisper-эндпоинт (`stt`);
 * 2. Мгновенный перевод (translateTextBetweenLanguages) с исходного языка на целевой язык;
 * 3. Отправка сообщения всем участникам ('all') или выбранному собеседнику (`toPeerId`);
 * 4. Автоматическая озвучка (TTS) входящих сообщений через пользовательский
 *    OpenAI-совместимый `/v1/audio/speech` эндпоинт (`tts`) либо через встроенный `speechSynthesis`;
 * 5. Маршрутизация WebRTC-сигналинга и синхронизация удаленной навигации/BT-устройств.
 *
 * Входные параметры:
 * - roomId, peerName, sourceLang, targetLang;
 * - endpointManager: для получения активных эндпоинтов llm / stt / tts / rtc.
 *
 * Выходные данные:
 * - Список подключенных участников SessionPeer[], лента сообщений TranslatedSpeechMessage[].
 */

import { STORAGE_KEYS } from '../constants';
import type {
  CustomEndpointConfig,
  SessionPeer,
  TranslatedSpeechMessage,
  TranslationLanguageCode,
  WirelessDeviceEntry,
} from '../types';
import { translateTextBetweenLanguages } from './translateTextBetweenLanguages';
import type { RemoteNavCommand } from './navigateRemotely';

export interface PeerCommsCallbacks {
  onPeersChanged?: (peers: SessionPeer[]) => void;
  onMessageReceived?: (msg: TranslatedSpeechMessage) => void;
  onNavCommand?: (cmd: RemoteNavCommand) => void;
  onDeviceSync?: (device: WirelessDeviceEntry) => void;
  onSttInterim?: (text: string) => void;
  onConnectionState?: (connected: boolean) => void;
}

export interface PeerCommsController {
  getPeerId(): string;
  connect(roomId: string, name: string, language: TranslationLanguageCode, device: string): void;
  updateProfile(name: string, language: TranslationLanguageCode): void;
  sendMessage(
    text: string,
    toPeerId: 'all' | string,
    sourceLang: TranslationLanguageCode,
    targetLang: TranslationLanguageCode,
    llmEndpoint?: CustomEndpointConfig
  ): Promise<void>;
  speakText(text: string, lang: TranslationLanguageCode, ttsEndpoint?: CustomEndpointConfig): Promise<void>;
  startListening(
    sourceLang: TranslationLanguageCode,
    onFinalTranscript: (text: string) => void
  ): boolean;
  stopListening(): void;
  broadcastNavCommand(cmd: RemoteNavCommand): void;
  broadcastDeviceSync(device: WirelessDeviceEntry): void;
  getPeers(): SessionPeer[];
  getMessages(): TranslatedSpeechMessage[];
  dispose(): void;
}

function getOrCreatePeerId(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.PEER_ID);
    if (saved) return saved;
    const generated = `xr-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(STORAGE_KEYS.PEER_ID, generated);
    return generated;
  } catch {
    return `xr-${Math.random().toString(36).slice(2, 8)}`;
  }
}

const SPEECH_LOCALE_MAP: Record<TranslationLanguageCode, string> = {
  en: 'en-US',
  ru: 'ru-RU',
  de: 'de-DE',
  es: 'es-ES',
  fr: 'fr-FR',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  ar: 'ar-SA',
};

export function createPeerCommsController(
  callbacks: PeerCommsCallbacks
): PeerCommsController {
  const peerId = getOrCreatePeerId();
  let ws: WebSocket | null = null;
  let peers: SessionPeer[] = [];
  const messages: TranslatedSpeechMessage[] = [];
  let currentRoomId = 'rokid-global-session';
  let currentName = 'XR-Explorer';
  let currentLang: TranslationLanguageCode = 'en';
  let currentDevice = 'Rokid WebXR';
  let reconnectTimer: number | null = null;
  let disposed = false;

  let recognition: SpeechRecognition | null = null;

  function connect(
    roomId: string,
    name: string,
    language: TranslationLanguageCode,
    device: string
  ): void {
    currentRoomId = roomId || 'rokid-global-session';
    currentName = name || 'XR-Explorer';
    currentLang = language;
    currentDevice = device;

    if (ws) {
      ws.onclose = null;
      ws.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      callbacks.onConnectionState?.(true);
      ws?.send(
        JSON.stringify({
          type: 'peer:join',
          roomId: currentRoomId,
          peerId,
          payload: {
            name: currentName,
            language: currentLang,
            device: currentDevice,
          },
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type: string;
          fromPeerId?: string;
          toPeerId?: string;
          peers?: SessionPeer[];
          payload?: Record<string, unknown>;
          timestamp?: number;
        };

        if (msg.type === 'peer:list' && Array.isArray(msg.peers)) {
          peers = msg.peers;
          callbacks.onPeersChanged?.(peers);
          return;
        }

        if (msg.type === 'speech:send' && msg.payload) {
          const item: TranslatedSpeechMessage = {
            id: `${msg.timestamp || Date.now()}-${msg.fromPeerId || 'peer'}`,
            fromPeerId: msg.fromPeerId || 'unknown',
            fromName: String(msg.payload.fromName || 'Peer'),
            toPeerId: msg.toPeerId || 'all',
            sourceLang: (msg.payload.sourceLang as TranslationLanguageCode) || 'en',
            targetLang: (msg.payload.targetLang as TranslationLanguageCode) || 'en',
            originalText: String(msg.payload.originalText || ''),
            translatedText: String(msg.payload.translatedText || ''),
            timestamp: msg.timestamp || Date.now(),
          };
          messages.push(item);
          if (messages.length > 60) messages.shift();
          callbacks.onMessageReceived?.(item);
          return;
        }

        if (msg.type === 'nav:command' && msg.fromPeerId !== peerId) {
          const cmd = msg.payload?.command as RemoteNavCommand | undefined;
          if (cmd) callbacks.onNavCommand?.(cmd);
          return;
        }

        if (msg.type === 'device:sync' && msg.fromPeerId !== peerId && msg.payload?.device) {
          callbacks.onDeviceSync?.(msg.payload.device as WirelessDeviceEntry);
        }
      } catch {
        // Игнорируем некорректные кадры
      }
    };

    ws.onclose = () => {
      callbacks.onConnectionState?.(false);
      if (!disposed) {
        reconnectTimer = window.setTimeout(() => {
          connect(currentRoomId, currentName, currentLang, currentDevice);
        }, 2500);
      }
    };
  }

  function updateProfile(name: string, language: TranslationLanguageCode): void {
    currentName = name;
    currentLang = language;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'peer:update',
          roomId: currentRoomId,
          peerId,
          payload: { name, language },
        })
      );
    }
  }

  async function sendMessage(
    text: string,
    toPeerId: 'all' | string,
    sourceLang: TranslationLanguageCode,
    targetLang: TranslationLanguageCode,
    llmEndpoint?: CustomEndpointConfig
  ): Promise<void> {
    const clean = text.trim();
    if (!clean) return;

    const { translatedText } = await translateTextBetweenLanguages(
      clean,
      sourceLang,
      targetLang,
      llmEndpoint
    );

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'speech:send',
          roomId: currentRoomId,
          peerId,
          toPeerId,
          payload: {
            fromName: currentName,
            sourceLang,
            targetLang,
            originalText: clean,
            translatedText,
          },
        })
      );
    } else {
      // Локальное эхо, если WebSocket еще переподключается
      const localMsg: TranslatedSpeechMessage = {
        id: `local-${Date.now()}`,
        fromPeerId: peerId,
        fromName: currentName,
        toPeerId,
        sourceLang,
        targetLang,
        originalText: clean,
        translatedText,
        timestamp: Date.now(),
      };
      messages.push(localMsg);
      callbacks.onMessageReceived?.(localMsg);
    }
  }

  async function speakText(
    text: string,
    lang: TranslationLanguageCode,
    ttsEndpoint?: CustomEndpointConfig
  ): Promise<void> {
    const clean = text.trim();
    if (!clean) return;

    // 1. Попытка синтеза через пользовательский OpenAI-совместимый TTS-эндпоинт (/audio/speech)
    if (ttsEndpoint && ttsEndpoint.enabled && ttsEndpoint.baseUrl.trim()) {
      const base = ttsEndpoint.baseUrl.trim().replace(/\/+$/, '');
      const url = base.endsWith('/audio/speech') ? base : `${base}/audio/speech`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ttsEndpoint.apiKey.trim()) {
        headers.Authorization = `Bearer ${ttsEndpoint.apiKey.trim()}`;
      }
      try {
        const res = await fetch('/api/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            method: 'POST',
            headers,
            data: {
              model: ttsEndpoint.model || 'tts-1',
              input: clean,
              voice: 'alloy',
            },
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          audioBase64?: string;
          contentType?: string;
        };
        if (json.ok && json.audioBase64) {
          const audio = new Audio(
            `data:${json.contentType || 'audio/mpeg'};base64,${json.audioBase64}`
          );
          await audio.play();
          return;
        }
      } catch {
        // Откатываемся на встроенный Web Speech Synthesis
      }
    }

    // 2. Встроенный браузерный синтезатор речи (работает оффлайн на Android и ПК)
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = SPEECH_LOCALE_MAP[lang] || 'en-US';
      window.speechSynthesis.speak(utterance);
    }
  }

  function startListening(
    sourceLang: TranslationLanguageCode,
    onFinalTranscript: (text: string) => void
  ): boolean {
    const SpeechRecCtor =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecCtor) {
      return false;
    }

    stopListening();
    recognition = new SpeechRecCtor();
    recognition.lang = SPEECH_LOCALE_MAP[sourceLang] || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let finalStr = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const txt = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalStr += txt;
        else interim += txt;
      }
      if (interim) callbacks.onSttInterim?.(interim);
      if (finalStr.trim()) onFinalTranscript(finalStr.trim());
    };

    recognition.onerror = () => {
      callbacks.onSttInterim?.('');
    };

    recognition.start();
    return true;
  }

  function stopListening(): void {
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // Игнорируем ошибку остановки
      }
      recognition = null;
    }
  }

  return {
    getPeerId: () => peerId,
    connect,
    updateProfile,
    sendMessage,
    speakText,
    startListening,
    stopListening,
    broadcastNavCommand: (cmd: RemoteNavCommand) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'nav:command',
            roomId: currentRoomId,
            peerId,
            toPeerId: 'all',
            payload: { command: cmd },
          })
        );
      }
    },
    broadcastDeviceSync: (device: WirelessDeviceEntry) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'device:sync',
            roomId: currentRoomId,
            peerId,
            toPeerId: 'all',
            payload: { device },
          })
        );
      }
    },
    getPeers: () => peers.slice(),
    getMessages: () => messages.slice(),
    dispose: () => {
      disposed = true;
      stopListening();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
