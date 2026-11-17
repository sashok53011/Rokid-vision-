/**
 * Серверный модуль (Express + WebSocket + Vite).
 *
 * Назначение:
 * 1. Раздача клиентского приложения (Vite middleware в dev-режиме, статическая сборка dist в production) на порту 3000.
 * 2. WebSocket-сервер (/ws) для реальных многопользовательских виртуальных сессий:
 *    - Регистрация и присутствие участников комнаты (peer:join, peer:leave, peer:update, peer:list);
 *    - Прямая маршрутизация сообщений речи (STT -> перевод -> TTS) по схеме "любой-к-любому" (all или конкретный peerId);
 *    - Сигналинг WebRTC (SDP offer/answer, ICE-кандидаты);
 *    - Синхронизация удаленной навигации и беспроводных устройств (BT/Wi-Fi) между платформами.
 * 3. Серверный прокси (/api/proxy) для обхода ограничений CORS при тестировании пользовательских
 *    OpenAI-совместимых эндпоинтов, RTC-серверов, облачного рендеринга и загрузке списка моделей (/v1/models).
 * 4. Опциональный серверный маршрут перевода через Gemini API (/api/gemini-translate) с использованием GEMINI_API_KEY.
 */

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';

interface PeerRecord {
  peerId: string;
  roomId: string;
  name: string;
  language: string;
  device: string;
  connectedAt: number;
  ws: WebSocket;
}

interface WsIncomingMessage {
  type: string;
  roomId?: string;
  peerId?: string;
  toPeerId?: string;
  payload?: Record<string, unknown>;
}

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function createServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Маршрут проверки состояния сервера
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'rokid-vision-xr-hub',
      timestamp: Date.now(),
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // Универсальный прокси для тестирования пользовательских OpenAI-совместимых и RTC/Cloud эндпоинтов без ошибок CORS
  app.post('/api/proxy', async (req, res) => {
    try {
      const body = req.body as {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        data?: unknown;
      };

      if (!body.url || !/^https?:\/\//i.test(body.url)) {
        res.status(400).json({ ok: false, error: 'Некорректный HTTP/HTTPS URL эндпоинта' });
        return;
      }

      const method = (body.method || 'GET').toUpperCase();
      const headers: Record<string, string> = {
        ...(body.headers || {}),
      };

      const fetchInit: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(15000),
      };

      if (method !== 'GET' && method !== 'HEAD' && body.data !== undefined) {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        fetchInit.body =
          typeof body.data === 'string' ? body.data : JSON.stringify(body.data);
      }

      const startedAt = performance.now();
      const upstream = await fetch(body.url, fetchInit);
      const latencyMs = Math.round(performance.now() - startedAt);
      const contentType = upstream.headers.get('content-type') || '';

      if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.status(upstream.status).json({
          ok: upstream.ok,
          status: upstream.status,
          latencyMs,
          contentType,
          audioBase64: buf.toString('base64'),
        });
        return;
      }

      const rawText = await upstream.text();
      let parsed: unknown = rawText;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // Оставляем текст как есть, если ответ не в формате JSON
      }

      res.status(200).json({
        ok: upstream.ok,
        status: upstream.status,
        latencyMs,
        contentType,
        data: parsed,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(502).json({ ok: false, error: msg });
    }
  });

  // Серверный перевод через Gemini API (используется как встроенный облачный переводчик, если ключ задан в окружении)
  app.post('/api/gemini-translate', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(400).json({
        ok: false,
        error: 'GEMINI_API_KEY не задан на сервере',
      });
      return;
    }

    try {
      const { text, sourceLang, targetLang } = req.body as {
        text?: string;
        sourceLang?: string;
        targetLang?: string;
      };
      if (!text) {
        res.status(400).json({ ok: false, error: 'Пустой текст для перевода' });
        return;
      }

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Translate the following text from "${sourceLang || 'auto'}" to "${targetLang || 'en'}". Return ONLY the translated text without quotes or commentary:\n\n${text}`,
      });

      res.json({
        ok: true,
        translatedText: (response.text || '').trim(),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  const server = http.createServer(app);

  // Реальный WebSocket-сервер для многопользовательской сессии (STT/TTS, WebRTC сигналинг, навигация, BT/Wi-Fi sync)
  const wss = new WebSocketServer({ server, path: '/ws' });
  const rooms = new Map<string, Map<string, PeerRecord>>();

  const getRoomPeersPayload = (roomId: string) => {
    const room = rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.values()).map((p) => ({
      peerId: p.peerId,
      name: p.name,
      language: p.language,
      device: p.device,
      connectedAt: p.connectedAt,
    }));
  };

  const broadcastRoomPeers = (roomId: string) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = JSON.stringify({
      type: 'peer:list',
      roomId,
      peers: getRoomPeersPayload(roomId),
    });
    for (const peer of room.values()) {
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(msg);
      }
    }
  };

  wss.on('connection', (ws) => {
    let activePeer: PeerRecord | null = null;

    ws.on('message', (raw) => {
      let msg: WsIncomingMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsIncomingMessage;
      } catch {
        return;
      }

      if (msg.type === 'peer:join' && msg.peerId) {
        const roomId = msg.roomId || 'default-xr-room';
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Map());
        }
        const room = rooms.get(roomId)!;
        activePeer = {
          peerId: msg.peerId,
          roomId,
          name: String(msg.payload?.name || `XR-${msg.peerId.slice(0, 4)}`),
          language: String(msg.payload?.language || 'en'),
          device: String(msg.payload?.device || 'WebXR Client'),
          connectedAt: Date.now(),
          ws,
        };
        room.set(msg.peerId, activePeer);
        broadcastRoomPeers(roomId);
        return;
      }

      if (!activePeer) return;
      const room = rooms.get(activePeer.roomId);
      if (!room) return;

      if (msg.type === 'peer:update') {
        if (msg.payload?.name) activePeer.name = String(msg.payload.name);
        if (msg.payload?.language) activePeer.language = String(msg.payload.language);
        if (msg.payload?.device) activePeer.device = String(msg.payload.device);
        broadcastRoomPeers(activePeer.roomId);
        return;
      }

      // Прямая маршрутизация: всем участникам комнаты или конкретному получателю (any-to-any)
      if (
        msg.type === 'speech:send' ||
        msg.type === 'rtc:signal' ||
        msg.type === 'nav:command' ||
        msg.type === 'device:sync'
      ) {
        const envelope = JSON.stringify({
          type: msg.type,
          fromPeerId: activePeer.peerId,
          toPeerId: msg.toPeerId || 'all',
          roomId: activePeer.roomId,
          payload: msg.payload || {},
          timestamp: Date.now(),
        });

        if (msg.toPeerId && msg.toPeerId !== 'all') {
          const target = room.get(msg.toPeerId);
          if (target && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(envelope);
          }
          // Подтверждаем отправителю, если это речевое сообщение
          if (msg.type === 'speech:send' && ws.readyState === WebSocket.OPEN) {
            ws.send(envelope);
          }
        } else {
          for (const peer of room.values()) {
            if (peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(envelope);
            }
          }
        }
      }
    });

    ws.on('close', () => {
      if (!activePeer) return;
      const room = rooms.get(activePeer.roomId);
      if (room) {
        room.delete(activePeer.peerId);
        if (room.size === 0) {
          rooms.delete(activePeer.roomId);
        } else {
          broadcastRoomPeers(activePeer.roomId);
        }
      }
    });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('/{*splat}', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Rokid Vision XR Hub] Сервер запущен на http://0.0.0.0:${PORT}`);
  });
}

void createServer();
