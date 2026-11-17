# Rokid Vision XR Hub

**Полная документация и аудит функций на трёх языках:**
- 🇷🇺 **Русский:** [`README.ru.md`](README.ru.md)
- 🇬🇧 **English:** [`README.en.md`](README.en.md)
- 🇩🇪 **Deutsch:** [`README.de.md`](README.de.md)

Модульная WebXR-платформа пространственного зрения, ML-детекции объектов и трекинга руки по камере, бесконтактных жестов головы, стереорендеринга, поддержки Rokid Max 1st Gen, BT-гироконтроллеров с 3D-лазером, процедурных 3D-комнат и многопользовательской связи с мгновенным переводом на базе **XR Blocks (`~0.24.0`)**, **Three.js (`~0.186.0`)**, **MediaPipe** и **Express + WebSocket**.

---

## 1. Сводка статуса реализации функций

### ✅ Полностью реализовано
- Модульная архитектура на строгом Vanilla TypeScript (`18` изолированных модулей в `/src/modules/`) + сцена `SpatialVisionScene` (`xb.Script`) + локализованный HUD (`EN / RU / DE`).
- Захват Android-камеры (`environment`/`user`) и ПК/USB веб-камер (`enumerateDevices()`, `devicechange`, `480p`/`720p`/`1080p`, зеркалирование, фоллбэк `{ video: true }`, 3D-экран `THREE.VideoTexture`).
- ML-детекция объектов в реальном времени (MediaPipe `ObjectDetector` EfficientDet-Lite0 GPU) + **Менеджер объектов детекции** (категории, поиск, `categoryAllowlist`, пользовательские классы, синонимы).
- Трекинг кисти (MediaPipe `HandLandmarker`, 21 точка) + **Визуальный диагностический оверлей** (скелетные кости, номера `#0–20`, вектор щипка, шкалы уверенности 5 жестов `0–100%`, 3D-скелет на `InstancedMesh`).
- Бесконтактные **жесты головы** (`xb.core.input.headGestures` + IMU: `nod`, `shake`, `tilt_left`, `tilt_right`).
- Режимы просмотра (`Auto`, `Monoscopic`, `SBS 3D Stereo` через `THREE.StereoCamera` + IPD 54–74 мм, `360°` купол).
- Плавная локальная и синхронизируемая по `/ws` **удаленная навигация** (`WASD`/стрелки/UI + `THREE.MathUtils.damp`).
- Поддержка стандартных **Bluetooth-гироконтроллеров** Android/Windows (Gamepad API + BLE GATT), рекалибровка, чувствительность и **3D-лазерный указатель** с кликом по `xb.UIButton` и 3D-пультам.
- **5 процедурных 3D-локаций и интерактивных пультов**: Лаборатория калибровки, Дата-центр (пульт NOC), Мостик космического корабля (штурманский пульт), Кабина самолета (авионика PFD/ND/EICAS и MCP), Архитектурный зал.
- **CRUD пользовательских эндпоинтов** (`llm`, `stt`, `tts`, `vision`, `rtc`, `cloud_render`) с проверкой соединения и загрузкой `/v1/models` через CORS-прокси `/api/proxy`.
- Многопользовательские комнаты `/ws` («любой-к-любому»), мгновенный перевод между 9 языками, TTS (`/v1/audio/speech` и `speechSynthesis`), STT (`SpeechRecognition`), диагностика WebGL FPS/памяти и Battery Status API.

### 🟡 Реализовано частично (с программными или аппаратными ограничениями)
1. **Протокол Rokid Max 1st Gen WebHID (`readRokidImuAndProtocol.ts`):** работают выбор HID-устройства (`VID 0x04D2`), чтение 64-байтных float32-пакетов, слияние с `DeviceOrientation`/WebXR и SLERP; не реализованы проприетарные `sendFeatureReport` разблокировки 1000 Гц и заводские матрицы калибровки из flash.
2. **Пользовательский Whisper STT (`communicatePeerTtsStt.ts`):** CRUD и тест `stt`-эндпоинта готовы, но захват микрофона работает через браузерный `SpeechRecognition`, без записи `MediaRecorder` -> `multipart/form-data` на `/v1/audio/transcriptions`.
3. **WebRTC аудио/видео P2P (`server.ts` + `communicatePeerTtsStt.ts`):** сервер ретранслирует `rtc:signal`, но на клиенте нет `RTCPeerConnection` (речь идет по цепочке STT -> перевод -> WS -> TTS).
4. **Облачный 3D-рендеринг (`streamCloudEnvironment.ts`):** WS/HTTP-подключение и подсчет FPS/битрейта реализованы, но входящие видеокадры еще не декодируются в `THREE.VideoTexture` / `domeMat.map`.
5. **Маршрутизация звука на конкретные BT-устройства (`balanceSpatialAudio.ts`):** работает HRTF-микшер Web Audio с виртуальными шинами на каждое BT-устройство, но без `AudioContext.setSinkId()` и без проброса `window.speechSynthesis` через Web Audio.
6. **Координаты рамок Vision LLM (`detectObjectsFromCamera.ts`):** произвольные классы уходят в `vision`-LLM, но рамки `bbox` генерируются синтетической сеткой.
7. **Мировая привязка 3D-скелета руки (`SpatialVisionScene.ts`):** 21-точечный 3D-скелет рисуется в фиксированном конусе перед камерой без depth-unprojection / WebXR `XRHand`.
8. **Парсер данных Wi-Fi/LAN-устройств (`connectBluetoothAndWifiDevices.ts`):** входящие WS-пакеты выводятся как строка `RX ...` без маппинга в 3D-актуаторы.

### 📋 Запланировано (Roadmap)
- CPU-делегат фоллбэк и оффлайн-бандлинг `.wasm`/`.tflite` моделей MediaPipe в `public/`.
- Клик по 3D-элементам щипком руки с веб-камеры (pinch raycast).
- Локальный оффлайн-перевод и распознавание речи на устройстве (Transformers.js / NLLB-200 / `whisper.wasm`).
- Нативный USB-C DP-Alt мост для переключения `1920x1080 <-> 3840x1080 SBS` на Rokid Max 1.
- Голосовое управление переключателями 3D-пультов (Дата-центр / Корабль / Самолет).

---

## 2. Реестр заглушек (Stubs) и чем заменить их в реальном коде

1. **Rokid Max HID парсер (`readRokidImuAndProtocol.ts`):** фиксированные смещения float32 + фоллбэк на `DeviceOrientation` → заменить на **Rokid UXR SDK / OpenHMD** и нативный Android USB-C OTG мост.
2. **Облачный 3D-поток (`streamCloudEnvironment.ts`):** `local-procedural` PBR-сцена + счетчик байт → заменить на **WebRTC Pixel Streaming** (`MediaStream` -> `THREE.VideoTexture`).
3. **Оффлайн-перевод (`translateTextBetweenLanguages.ts`):** префикс `[LANG] <текст>` → заменить на активный `llm` API / `GEMINI_API_KEY` или **Transformers.js (NLLB-200 / Opus-MT)**.
4. **Виртуальный BT-гироконтроллер (`connectBluetoothGyroController.ts`):** режим `simulated-bt` (мышь + `Space` + `Alt+C`) → заменить в релизе на физические **Gamepad API (`gamepad.pose`)** и **BLE GATT**.
5. **Тестовый скелет руки (`trackHandsFromCamera.ts`):** генератор `createSimulatedHandState()` → использовать только живой `HandLandmarker` / WebXR `XRHand`.
6. **Виртуальные аудиошины BT (`balanceSpatialAudio.ts`):** программные `DeviceAudioBus` → заменить на `enumerateDevices('audiooutput')` + `AudioContext.setSinkId()` или Android `AudioManager`.
7. **Открыто-словарная детекция (`manageDetectionClasses.ts`, `detectObjectsFromCamera.ts`):** 80 классов COCO + синтетические `bbox` от VLM → заменить на **YOLO-World / GroundingDINO** ONNX/WebGPU или JSON-координаты VLM.
8. **Телеметрия 3D-пультов (`build3dPlacesAndControlPanels.ts`):** локальная симуляция NOC, корабля и авионики → подключить к **Prometheus/SNMP/MQTT** или **X-Plane UDP / MSFS SimConnect**.
9. **Захват речи Whisper STT (`communicatePeerTtsStt.ts`):** браузерный `SpeechRecognition` → заменить на `MediaRecorder` / VAD + отправку на `/v1/audio/transcriptions` через `/api/proxy` или `whisper.wasm`.
10. **WebRTC клиент (`server.ts` + `communicatePeerTtsStt.ts`):** серверный релей `rtc:signal` без клиентского `RTCPeerConnection` → реализовать P2P `RTCPeerConnection` и OpenAI Realtime `wss://`.

---

## 3. Запуск

```bash
npm install
npm run dev      # http://localhost:3000 (Express + /ws + Vite)
npm run build    # Сборка dist/
npm start        # Продакшн-режим
```
