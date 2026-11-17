# Rokid Vision XR Hub — Полная техническая документация (Русский)

**Языки документации:** [English](README.en.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Краткий обзор](README.md)

**Rokid Vision XR Hub** — модульная WebXR-платформа пространственного зрения, ML-детекции, трекинга рук/головы, стереорендеринга, BT-гироконтроллеров и многопользовательской голосовой связи с мгновенным переводом. Построена на базе **XR Blocks (`~0.24.0`)**, **Three.js (`~0.186.0`)**, **MediaPipe Tasks Vision (`@mediapipe/tasks-vision`)** и **Express + WebSocket (`ws`)**.

Поддерживает **Android-камеры**, **ПК/USB веб-камеры**, **VR-гарнитуры**, **Android/Windows Bluetooth-гироконтроллеры** и очки дополненной реальности **Rokid Max (1-го поколения)**.

---

## 1. Матрица готовности функций

### ✅ 1.1. Полностью реализованные функции

| Подсистема | Что именно реализовано | Ключевые файлы |
|---|---|---|
| **Базовый рантайм и 3D-сцена** | Архитектура `xb.Script` на строгом Vanilla TypeScript, инициализация XR Blocks (`enableHands`, `enableHeadGestures`, `enableReticles`, `enableObjectDetection`), главный цикл обновления и освобождение ресурсов (`dispose`). | `src/index.ts`, `src/xr/SpatialVisionScene.ts` |
| **Android-камеры и USB/ПК веб-камеры** | Захват тыльной/фронтальной камеры Android и внешних веб-камер (`enumerateDevices()`, горячее подключение `devicechange`), профили `480p`/`720p`/`1080p`, зеркалирование, цепочка фоллбэков ограничений (`{ video: true }`), плавающий 3D-экран `THREE.VideoTexture` в сцене. | `src/modules/detectObjectsFromCamera.ts` |
| **ML-детекция объектов в реальном времени** | Инференс MediaPipe `ObjectDetector` (`efficientdet_lite0.tflite`, GPU delegate, режим `VIDEO`) с нормализованными рамками и оценкой уверенности, плюс опциональный опрос мультимодального `vision`-эндпоинта. | `src/modules/detectObjectsFromCamera.ts` |
| **Менеджер объектов детекции («Detection Objects»)** | Карточка фильтрации классов по 4 категориям (`furniture`, `personal`, `electronics`, `environment`), поиск по классам, переключение «Все классы» / «Выборочно», динамическое обновление MediaPipe `categoryAllowlist` через `setOptions()`, словарь синонимов и пользовательские классы. | `src/modules/manageDetectionClasses.ts`, `src/ui/renderControlHud.ts` |
| **Трекинг руки и визуальный диагностический оверлей** | MediaPipe `HandLandmarker` (21 ключевая точка), расчет расстояния щипка (Pinch), классификация жестов (`Pinch`, `Open Palm`, `Point`, `Fist`, `Victory`), плавающий диагностический HUD `#hand-diag-overlay` со скелетом, номерами точек `#0–20`, вектором щипка и шкалами уверенности `0–100%`, плюс 3D-скелет из `InstancedMesh` и `LineSegments`. | `src/modules/trackHandsFromCamera.ts`, `src/modules/renderHandDiagnosticOverlay.ts` |
| **Бесконтактный интерфейс по жестам головы** | Интеграция встроенного `xb.core.input.headGestures` и собственного анализатора угловой истории IMU: `nod` (развернуть HUD / скан сцены), `shake` (свернуть HUD), `tilt_left` / `tilt_right` (переключение вкладок) с защитой от дребезга (cooldown). | `src/modules/recognizeHeadGestures.ts` |
| **Режимы просмотра и стереорендеринг** | Автовыбор и ручное переключение между `Monoscopic`, `SBS 3D Stereo` (`THREE.StereoCamera` с регулировкой IPD 54–74 мм и двойным viewport/scissor-рендером) и `360°` панорамным куполом. | `src/modules/switchViewingMode.ts` |
| **Удаленная и локальная навигация** | Демпфированное (`THREE.MathUtils.damp`) движение и поворот `worldRig` (`forward`, `back`, `left`, `right`, `reset`) с кнопок HUD, клавиатуры (`WASD`/стрелки/`R`) и по WebSocket-командам `nav:command`. | `src/modules/navigateRemotely.ts` |
| **BT-гироконтроллер и 3D-лазерный указатель** | Поддержка Bluetooth-контроллеров Android и Windows через Web Gamepad API (`gamepad.pose` и аналоговые стики) и Web Bluetooth BLE GATT, рекалибровка центра (`recenter`), чувствительность, объемный 3D-луч с коллизионной точкой (`Raycaster`) и клик по `xb.UIButton` / 3D-кнопкам пультов. | `src/modules/connectBluetoothGyroController.ts`, `src/xr/SpatialVisionScene.ts` |
| **Процедурные 3D-локации и пульты управления** | 5 лениво создаваемых комнат без внешних 404-ассетов: `calibration_lab`, `datacenter` (пульт NOC, 42U стойки, LED на `InstancedMesh`, кулеры), `spaceship` (Warp-звезды, планета, сфера щитов, штурманский пульт и радар), `airplane` (кабина со стеклянной авионикой PFD/ND/EICAS, штурвалы, РУД, MCP автопилот), `cyber_lounge` (голографический город). | `src/modules/build3dPlacesAndControlPanels.ts` |
| **Управление пользовательскими эндпоинтами** | Неограниченный CRUD (добавление, редактирование, удаление по одному/всех, вкл/выкл) для типов `llm`, `stt`, `tts`, `vision`, `rtc`, `cloud_render` с сохранением в `localStorage`, кнопками **Тест соединения** и **Загрузить модели** (`/v1/models`) через прокси `/api/proxy`. | `src/modules/manageCustomEndpoints.ts`, `server.ts` |
| **Прямая связь (TTS/STT), перевод и комнаты `/ws`** | WebSocket-сервер комнат (`peer:join`, `peer:update`, `peer:leave`, `peer:list`, `speech:send`), адресация `all` или конкретному участнику (`toPeerId`), перевод между 9 языками, захват речи `SpeechRecognition` и озвучивание `speechSynthesis` / OpenAI `/v1/audio/speech`. | `server.ts`, `src/modules/communicatePeerTtsStt.ts`, `src/modules/translateTextBetweenLanguages.ts` |
| **Диагностика производительности и батареи** | Расчет в реальном времени FPS, времени кадра (мс), WebGL Draw Calls, треугольников, геометрий/текстур, JS Heap (`performance.memory`), задержек ML/IMU, эвристики термосостояния и статуса аккумулятора (`navigator.getBattery()`). | `src/modules/monitorPerformanceAndBattery.ts` |
| **Полная локализация EN / RU / DE** | Переключение языка на лету для всех вкладок 2D HUD, оверлея трекинга руки и пространственных 3D-карточек `xb.UICard`. | `src/modules/localizeInterface.ts` |

---

### 🟡 1.2. Функции, реализованные не до конца (частично / с аппаратными ограничениями)

1. **Протокол Rokid Max 1st Gen USB HID (`src/modules/readRokidImuAndProtocol.ts`):**
   - *Что работает:* автоопределение гарнитуры по User-Agent и соотношению сторон `32:9` (`3840x1080`), WebHID-запрос устройства (`VID 0x04D2` / `0x2833`), открытие соединения, чтение `inputreport`, слияние с `DeviceOrientation`/`DeviceMotion` и WebXR-позой с SLERP-стабилизацией.
   - *Что не доделано:* нет отправки проприетарных команд инициализации (`sendFeatureReport` для перевода датчика в высокочастотный режим) и декодирования заводских матриц калибровки из flash-памяти очков.
2. **Пользовательский STT-эндпоинт Whisper (`src/modules/communicatePeerTtsStt.ts`):**
   - *Что работает:* настройка, хранение, проверка доступности и список моделей для типа `stt`, а также распознавание речи через браузерный `SpeechRecognition`.
   - *Что не доделано:* в функции `startListening()` пока не подключена запись аудиофрагмента (`MediaRecorder` -> `Blob` -> `multipart/form-data` на `/v1/audio/transcriptions`), поэтому пользовательский `stt`-эндпоинт в реальном времени не вызывается вместо системного `SpeechRecognition`.
3. **WebRTC-связь и аудио/видеопотоки «точка-точка» (`server.ts`, `src/modules/communicatePeerTtsStt.ts`):**
   - *Что работает:* сервер `/ws` пересылает пакеты `rtc:signal`, а менеджер эндпоинтов тестирует `wss://` RTC-адреса.
   - *Что не доделано:* на клиенте не создается `RTCPeerConnection` и нет обработчика входящих `rtc:signal` (SDP offer/answer и ICE-кандидатов); голосовая связь работает через цикл `STT -> перевод -> WS текст -> TTS`.
4. **Облачный 3D-рендеринг (`src/modules/streamCloudEnvironment.ts`):**
   - *Что работает:* подключение по `ws://`/`wss://` или HTTP-зонд, подсчет входящих кадров (`frameCount`) и битрейта (`bitrateKbps`), локальная процедурная PBR-сцена (`RoomEnvironment`, 3-точечный свет, сетка, `InstancedMesh`).
   - *Что не доделано:* бинарные/видео-кадры из `cloudSocket.onmessage` не декодируются в `THREE.Texture` / `VideoFrame` и не накладываются на `domeMat.map`.
5. **Маршрутизация звука на конкретные Bluetooth-устройства (`src/modules/balanceSpatialAudio.ts`):**
   - *Что работает:* граф Web Audio API (`PannerNode` с `HRTF`, `StereoPannerNode`, `GainNode`), привязка `AudioListener` к камере, индивидуальные профили усиления/панорамы/затухания для каждого BT-устройства и генератор 3D-тестового тона.
   - *Что не доделано:* `window.speechSynthesis` не проходит через граф Web Audio, метод `getEffectiveVolumeForTts()` еще не передается в `Audio.volume` / `SpeechSynthesisUtterance.volume`, а привязка `AudioContext.setSinkId()` к физическим A2DP-выходам ОС не реализована.
6. **Определение координат рамок от Vision LLM (`src/modules/detectObjectsFromCamera.ts`):**
   - *Что работает:* пользовательские классы (вне словаря COCO) отправляются в промпт активного `vision`-эндпоинта.
   - *Что не доделано:* ответы текстового Vision LLM не парсятся как реальные координаты `[ymin, xmin, ymax, xmax]`, вместо них подставляются равномерно распределенные рамки.
7. **Проекция 3D-скелета руки в мировую систему координат (`src/xr/SpatialVisionScene.ts`):**
   - *Что работает:* отображается полный 21-точечный 3D-скелет и индикатор щипка перед камерой.
   - *Что не доделано:* координаты жестко привязаны к локальной области перед глазами, а не преобразуются через карту глубины или нативный WebXR `XRHand` (`hand-tracking`).
8. **Парсер данных сторонних Wi-Fi/LAN-устройств (`src/modules/connectBluetoothAndWifiDevices.ts`):**
   - *Что работает:* подключение по `ws://` / HTTP, чтение GATT `battery_service` по BLE, отображение статуса и синхронизация списка устройств между участниками комнаты.
   - *Что не доделано:* входящие сообщения Wi-Fi-сокета (`ws.onmessage`) выводятся как сырая строка `RX ...`, без привязки к датчикам/актуаторам сцены.

---

### 📋 1.3. Запланированные, но еще не реализованные функции (Roadmap)

- **CPU-фоллбэк и оффлайн-бандлинг MediaPipe:** при ошибке GPU-делегата (`delegate: 'GPU'`) или отсутствии интернета `detectObjectsFromCamera` и `trackHandsFromCamera` сейчас выставляют `modelLoadFailed = true` без повторной попытки с `delegate: 'CPU'` и без локальных `.tflite`/`.wasm` файлов в `public/`.
- **Интерактивный клик щипком руки с веб-камеры по 3D UI:** сейчас по 3D-кнопкам и пультам кликают WebXR-контроллер/мышь (`onSelectStart`) или BT-лазер; жест щипка с обычной веб-камеры пока служит только визуальным маркером и диагностикой.
- **Локальный оффлайн-нейроперевод и локальный Whisper (WebGPU/WASM):** интеграция `@huggingface/transformers` (NLLB-200 / Opus-MT / Whisper-tiny) для работы полностью без облачных API.
- **Аппаратный USB-C DP-Alt драйвер/сервис-компаньон для Rokid Max 1:** программное переключение режима дисплея очков `1920x1080 <-> 3840x1080 SBS` невозможно из песочницы браузера и требует нативного Android/Desktop-сервиса.
- **Голосовое управление 3D-пультами (Дата-центр / Корабль / Самолет):** привязка распознанных команд STT/LLM к автоматическому переключению тумблеров на 3D-консолях.

---

## 2. Полный реестр модулей (`/src/modules/`)

1. **`detectObjectsFromCamera.ts` (`createCameraObjectDetector`)** — захват Android/USB-камер, смена устройств и разрешений (`480p`/`720p`/`1080p`), MediaPipe `ObjectDetector`, вызов `vision`-эндпоинта. *Вход:* `StartCameraOptions`, `allowlist`, `visionEndpoint`. *Выход:* `{ entities, inferenceMs }`, `WebcamDeviceInfo[]`, `WebcamStreamMeta`.
2. **`manageDetectionClasses.ts` (`createDetectionClassManager`)** — каталог классов (`furniture`, `personal`, `electronics`, `environment`), пользовательские классы, `categoryAllowlist`, фильтрация `DetectedEntity[]` с синонимами.
3. **`trackHandsFromCamera.ts` (`createCameraHandTracker`, `evaluateGestureScores`, `createSimulatedHandState`)** — MediaPipe `HandLandmarker` (21 точка), расчет уверенности 5 жестов и генератор тестового скелета.
4. **`renderHandDiagnosticOverlay.ts` (`createHandDiagnosticOverlay`, `drawHandSkeletonOnCanvas`, `HAND_SKELETON_CONNECTIONS`)** — плавающий диагностический HUD руки, отрисовка костей, индексов `#0–20` и шкал уверенности.
5. **`recognizeHeadGestures.ts` (`createHeadGestureController`)** — обработка жестов головы (`nod`, `shake`, `tilt_left`, `tilt_right`) от XR Blocks и IMU.
6. **`readRokidImuAndProtocol.ts` (`createRokidImuController`)** — идентификация гарнитур, WebHID Rokid Max 1, слияние `DeviceOrientation`/WebXR и SLERP-стабилизация.
7. **`switchViewingMode.ts` (`createViewingModeController`)** — переключение `Monoscopic`, `SBS 3D Stereo` (IPD) и `360°`.
8. **`navigateRemotely.ts` (`createRemoteNavigationController`)** — демпфированное перемещение сцены и синхронизация команд `nav:command`.
9. **`connectBluetoothAndWifiDevices.ts` (`createWirelessDeviceHub`)** — сопряжение BLE GATT, Wi-Fi/LAN-узлы, синхронизация списка устройств в комнате.
10. **`connectBluetoothGyroController.ts` (`createBluetoothGyroController`)** — Android/Windows BT-гироконтроллеры (Gamepad API, BLE GATT, виртуальная заглушка), рекалибровка и телеметрия для 3D-лазера.
11. **`balanceSpatialAudio.ts` (`createSpatialAudioBalancer`)** — Web Audio HRTF `PannerNode`, `StereoPannerNode`, `GainNode`, профили BT-устройств, тестовый сигнал.
12. **`streamCloudEnvironment.ts` (`createCloudEnvironmentController`)** — клиент потока `cloud_render` и базовая процедурная PBR-лаборатория Rokid.
13. **`build3dPlacesAndControlPanels.ts` (`createSpatialPlacesManager`)** — 5 процедурных 3D-комнат (`calibration_lab`, `datacenter`, `spaceship`, `airplane`, `cyber_lounge`) и кликабельные 3D-пульты.
14. **`monitorPerformanceAndBattery.ts` (`createDiagnosticsMonitor`)** — мониторинг FPS, WebGL-счетчиков, памяти, задержек и батареи.
15. **`manageCustomEndpoints.ts` (`createEndpointManager`)** — CRUD для `llm`, `stt`, `tts`, `vision`, `rtc`, `cloud_render`, тест соединения и `/v1/models`.
16. **`translateTextBetweenLanguages.ts` (`translateTextBetweenLanguages`)** — перевод `custom-openai` -> `gemini-server` -> `offline-stub`.
17. **`communicatePeerTtsStt.ts` (`createPeerCommsController`)** — клиент комнаты `/ws`, STT, перевод, TTS, трансляция навигации и устройств.
18. **`localizeInterface.ts` (`createTranslator`)** — словарь переводов и реактивное обновление интерфейса (EN / RU / DE).

---

## 3. Все места с заглушками (Stubs) и чем заменить их в продакшне

| № | Файл и символ | Что именно заглушено | Чем заменить в реальном коде (Production) |
|---|---|---|---|
| 1 | `src/modules/readRokidImuAndProtocol.ts` -> `onHidInputReport()` | Читаются базовые float32 смещения `(4,8,12,16)` без фирменного handshake и заводских матриц калибровки; при отсутствии USB используется `DeviceOrientation`/WebXR. | Интегрировать парсер **Rokid UXR SDK / OpenHMD** с HID Feature Report активации 1000 Гц и нативным Android USB-C OTG мостом. |
| 2 | `src/modules/streamCloudEnvironment.ts` -> `setCloudStream()` / `cloudSocket.onmessage` | При отсутствии удаленного GPU-сервера включается локальная PBR-сцена (`local-procedural`), а по WebSocket подсчитываются только байты без декодирования кадра. | Подключить **WebRTC Pixel Streaming** (`MediaStream` -> `THREE.VideoTexture`) или headless Three.js/Vulkan рендер-сервер с передачей видеопотока. |
| 3 | `src/modules/translateTextBetweenLanguages.ts` -> `offline-stub` | При отсутствии ключа `llm`-эндпоинта и `GEMINI_API_KEY` возвращается строка `[TARGET_LANG] <текст>`. | Настроить ключ OpenAI/Gemini или встроить локальную WASM/WebGPU модель перевода (**Transformers.js NLLB-200 / Opus-MT**). |
| 4 | `src/modules/connectBluetoothGyroController.ts` -> `connectVirtualGyroStub()` | Режим `simulated-bt` эмулирует BT-гироконтроллер мышью, `Space` и `Alt+C` для отладки на ПК без реального пульта. | Использовать только реальный поток **Gamepad API (`gamepad.pose`)** и **Web Bluetooth BLE GATT** (или нативный Android HID Service), отключив эмулятор в релизе. |
| 5 | `src/modules/trackHandsFromCamera.ts` -> `createSimulatedHandState()` | Генерирует синтетический 21-точечный скелет (`isSimulated: true`) для проверки оверлея диагностики без камеры. | Использовать поток реального `HandLandmarker` или WebXR **Hand Tracking API (`XRHand`)** без ручной генерации координат. |
| 6 | `src/modules/balanceSpatialAudio.ts` -> `ensureDeviceBus()` | Создает программные шины Web Audio на каждое BT-устройство вместо раздельного вывода на разные физические наушники/колонки. | Использовать `navigator.mediaDevices.enumerateDevices()` + `AudioContext.setSinkId(sinkId)` на десктопе или нативный Android `AudioManager`. |
| 7 | `src/modules/manageDetectionClasses.ts` и `detectObjectsFromCamera.ts` -> `queryVisionEndpointIfEnabled()` | Локальный MediaPipe знает только 80 классов COCO; для пользовательских классов вызывается `vision`-LLM, а `bbox` выставляются синтетической сеткой. | Заменить локальный детектор на открыто-словарную ONNX/WebGPU модель (**YOLO-World / GroundingDINO**) или запрашивать у VLM точный JSON `[ymin, xmin, ymax, xmax]`. |
| 8 | `src/modules/build3dPlacesAndControlPanels.ts` -> `buildDatacenterPlace()`, `buildSpaceshipPlace()`, `buildAirplanePlace()`, `buildCyberLoungePlace()` | Значения датчиков NOC (°C, PUE, кВт), мостика (Warp, щиты, радар) и авионики (IAS, ALT, N1, шасси, закрылки) рассчитываются локально математикой. | Привязать `redrawScreen()` и `triggerAction()` к реальным **Prometheus / SNMP / MQTT** брокерам или протоколам авиасимуляторов (**X-Plane UDP / MSFS SimConnect**). |
| 9 | `src/modules/communicatePeerTtsStt.ts` -> `startListening()` | Использует только браузерный `SpeechRecognition` (не задействует пользовательский Whisper `stt`-эндпоинт). | Добавить захват через `MediaRecorder` / `AudioWorklet` + VAD и отправку аудио в `/v1/audio/transcriptions` через `/api/proxy` либо локальный `whisper.wasm`. |
| 10 | `server.ts` + `src/modules/communicatePeerTtsStt.ts` -> `rtc:signal` | Серверная пересылка `rtc:signal` уже реализована, но клиентский WebRTC `RTCPeerConnection` отсутствует. | Реализовать менеджер `RTCPeerConnection` (offer/answer/ICE + OpenAI Realtime `wss://` аудиопоток) для низколатентного P2P аудио/видео. |

---

## 4. Серверный API и WebSocket (`server.ts`)

- `GET /api/health` — состояние сервера и флаг наличия `GEMINI_API_KEY`.
- `POST /api/proxy` — CORS-прокси (`{ url, method, headers, data }`) для проверки эндпоинтов, загрузки `/v1/models` и проксирования аудио/LLM/Vision.
- `POST /api/gemini-translate` — серверный переводчик на `@google/genai` (`gemini-2.5-flash`).
- `WS /ws` — комнаты сессий: `peer:join`, `peer:update`, `peer:leave`, `peer:list`, `speech:send`, `rtc:signal`, `nav:command`, `device:sync`.

---

## 5. Запуск и сборка

```bash
npm install
npm run dev      # Запуск в режиме разработки на http://localhost:3000
npm run build    # Сборка клиентского бандла Vite (dist/)
npm start        # Продакшн-сервер Express + WS + статика dist/
```
