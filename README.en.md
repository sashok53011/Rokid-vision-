# Rokid Vision XR Hub — Full Technical Documentation (English)

**Documentation Languages:** [English](README.en.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Overview](README.md)

**Rokid Vision XR Hub** is a modular WebXR platform for spatial computer vision, ML object & hand tracking, head-gesture touchless UI, stereo rendering, Bluetooth gyro pointers, procedural 3D environments, and any-to-any translated voice communication. Built on **XR Blocks (`~0.24.0`)**, **Three.js (`~0.186.0`)**, **MediaPipe Tasks Vision (`@mediapipe/tasks-vision`)**, and **Express + WebSocket (`ws`)**.

Supports **Android cameras**, **desktop/USB webcams**, **VR headsets**, **Android/Windows Bluetooth gyro controllers**, and **Rokid Max (1st Generation)** AR glasses.

---

## 1. Feature Completion Matrix

### ✅ 1.1. Completely Implemented Features

| Subsystem | What Is Implemented | Source Files |
|---|---|---|
| **Core Runtime & XR Scene** | Strict Vanilla TypeScript `xb.Script` architecture, XR Blocks initialization (`enableHands`, `enableHeadGestures`, `enableReticles`, `enableObjectDetection`), frame loop, and cleanup (`dispose`). | `src/index.ts`, `src/xr/SpatialVisionScene.ts` |
| **Android & USB/Desktop Webcams** | Rear/front Android camera & external webcam capture (`enumerateDevices()`, hot-plug `devicechange`), `480p`/`720p`/`1080p` presets, horizontal mirror toggle, `{ video: true }` fallback chain, and floating 3D `THREE.VideoTexture` preview card. | `src/modules/detectObjectsFromCamera.ts` |
| **Real-Time ML Object Detection** | MediaPipe `ObjectDetector` (`efficientdet_lite0.tflite`, GPU delegate, `VIDEO` mode) producing normalized bounding boxes and confidence scores, plus optional OpenAI-compatible `vision` endpoint querying. | `src/modules/detectObjectsFromCamera.ts` |
| **Detection Objects Manager** | Dashboard filter card across 4 categories (`furniture`, `personal`, `electronics`, `environment`), class search, Track All / Custom Filter modes, live MediaPipe `categoryAllowlist` updates via `setOptions()`, synonym matching, and custom class additions. | `src/modules/manageDetectionClasses.ts`, `src/ui/renderControlHud.ts` |
| **Hand Tracking & Diagnostic Overlay** | MediaPipe `HandLandmarker` (21 3D landmarks), pinch distance calculation, gesture classification (`Pinch`, `Open Palm`, `Point`, `Fist`, `Victory`), floating `#hand-diag-overlay` HUD with skeleton bones, landmark IDs `#0–20`, pinch vector & `0–100%` confidence meters, plus 3D `InstancedMesh` + `LineSegments` skeleton. | `src/modules/trackHandsFromCamera.ts`, `src/modules/renderHandDiagnosticOverlay.ts` |
| **Touch-Free Head Gesture UI** | Combines XR Blocks `xb.core.input.headGestures` with IMU angular history heuristics: `nod` (expand HUD / scan), `shake` (collapse HUD), `tilt_left` / `tilt_right` (cycle HUD tabs) with cooldown protection. | `src/modules/recognizeHeadGestures.ts` |
| **Viewing Modes & Stereo Rendering** | Auto-selection & manual override between `Monoscopic`, `SBS 3D Stereo` (`THREE.StereoCamera` with 54–74 mm IPD slider and dual-viewport scissor rendering), and `360° Dome`. | `src/modules/switchViewingMode.ts` |
| **Remote & Local Navigation** | Exponentially damped (`THREE.MathUtils.damp`) `worldRig` translation and yaw rotation (`forward`, `back`, `left`, `right`, `reset`) via HUD buttons, keyboard (`WASD`/Arrows/`R`), and synced WebSocket `nav:command` messages. | `src/modules/navigateRemotely.ts` |
| **BT Gyro Controller & 3D Laser Pointer** | Standard Android/Windows Bluetooth controllers via Web Gamepad API (`gamepad.pose` and thumbstick fallback) and Web Bluetooth BLE GATT, quick recenter calibration, sensitivity scaling, volumetric 3D laser beam with raycast hit dot, and trigger clicks on `xb.UIButton` and 3D room panel controls. | `src/modules/connectBluetoothGyroController.ts`, `src/xr/SpatialVisionScene.ts` |
| **Procedural 3D Places & Control Panels** | 5 lazily constructed zero-404 rooms: `calibration_lab`, `datacenter` (NOC control desk, 42U racks, `InstancedMesh` blinking LEDs, spinning fans), `spaceship` (warp starfield, ringed planet, shield orb, helm console & radar), `airplane` (PFD/ND/EICAS glass avionics, dual yokes, throttles, MCP autopilot), and `cyber_lounge` (holographic city diorama). | `src/modules/build3dPlacesAndControlPanels.ts` |
| **Custom Endpoints Manager** | Unlimited CRUD (add, edit, delete single/all, toggle enabled) for `llm`, `stt`, `tts`, `vision`, `rtc`, and `cloud_render` endpoints persisted in `localStorage`, with **Test Connection** and **Fetch Model List** (`/v1/models`) via `/api/proxy`. | `src/modules/manageCustomEndpoints.ts`, `server.ts` |
| **Any-to-Any Peer Comms (TTS/STT) & Translation** | Multi-user WebSocket `/ws` rooms (`peer:join`, `peer:update`, `peer:leave`, `peer:list`, `speech:send`), direct targeting (`all` or specific `toPeerId`), live translation across 9 languages, `SpeechRecognition` capture, and TTS playback (`speechSynthesis` or OpenAI `/v1/audio/speech`). | `server.ts`, `src/modules/communicatePeerTtsStt.ts`, `src/modules/translateTextBetweenLanguages.ts` |
| **Performance & Battery Diagnostics** | Real-time FPS, frame time (ms), WebGL draw calls, triangles, geometries/textures, JS heap (`performance.memory`), ML/IMU latencies, thermal heuristic, and Battery Status API (`navigator.getBattery()`). | `src/modules/monitorPerformanceAndBattery.ts` |
| **Full EN / RU / DE Localization** | Instant runtime switching for all 2D HUD tabs, hand diagnostic overlay, and 3D `xb.UICard` controls. | `src/modules/localizeInterface.ts` |

---

### 🟡 1.2. Partially Implemented Features (Hardware / Browser Limitations)

1. **Rokid Max 1st Gen USB HID Protocol Calibration (`src/modules/readRokidImuAndProtocol.ts`):**
   - *Working:* Auto-detects Rokid Max via User-Agent & `32:9` (`3840x1080`) aspect ratio, opens WebHID (`VID 0x04D2` / `0x2833`), parses `inputreport` packets, and fuses `DeviceOrientation`/`DeviceMotion` & WebXR poses with SLERP stabilization.
   - *Incomplete:* Does not send proprietary `sendFeatureReport` unlock commands (e.g., 1000Hz raw IMU activation) or parse factory flash magnetometer/accelerometer calibration matrices.
2. **Custom Whisper STT Endpoint Invocation (`src/modules/communicatePeerTtsStt.ts`):**
   - *Working:* Full CRUD, connection test, and `/v1/models` fetch for `stt` endpoints, plus working browser `SpeechRecognition` STT.
   - *Incomplete:* `startListening()` does not record audio via `MediaRecorder` / `AudioWorklet` into a `Blob` and post `multipart/form-data` to `/v1/audio/transcriptions`, so user-configured Whisper `stt` endpoints are not invoked during speech capture yet.
3. **WebRTC Peer-to-Peer Audio/Video Streaming (`server.ts`, `src/modules/communicatePeerTtsStt.ts`):**
   - *Working:* Backend `/ws` relays `rtc:signal` envelopes between room peers, and `manageCustomEndpoints.ts` tests `wss://` RTC URLs.
   - *Incomplete:* Client lacks an `RTCPeerConnection` manager and `rtc:signal` listener (Offer/Answer/ICE); voice chat currently operates via `STT -> translation -> WS text -> TTS`.
4. **Cloud 3D Render Frame Decoding (`src/modules/streamCloudEnvironment.ts`):**
   - *Working:* Connects to `ws://`/`wss://` or HTTP probes, tracks `frameCount` and `bitrateKbps`, and renders a procedural PBR local scene.
   - *Incomplete:* `cloudSocket.onmessage` counts incoming bytes without decoding binary JPEG/WebRTC `VideoFrame` payloads onto `domeMat.map`.
5. **Per-Bluetooth Audio Sink Routing (`src/modules/balanceSpatialAudio.ts`):**
   - *Working:* Web Audio API `AudioContext`, HRTF `PannerNode`, `StereoPannerNode`, `GainNode`, camera-synced `AudioListener`, per-BT virtual buses (`DeviceAudioBus`), and 3D test tones.
   - *Incomplete:* `window.speechSynthesis` bypasses the Web Audio graph, `getEffectiveVolumeForTts()` is not yet wired into `<audio>.volume` / `SpeechSynthesisUtterance.volume`, and `AudioContext.setSinkId()` is not bound to OS A2DP device IDs.
6. **Open-Vocabulary Vision LLM Bounding Boxes (`src/modules/detectObjectsFromCamera.ts`):**
   - *Working:* Non-COCO custom classes are forwarded in the Vision LLM prompt.
   - *Incomplete:* Vision LLM responses return text labels, so bounding boxes are distributed synthetically (`bbox: [0.15 + i * 0.18, ...]`) instead of parsed pixel coordinates.
7. **World-Anchored 3D Hand Projection (`src/xr/SpatialVisionScene.ts`):**
   - *Working:* Full 21-joint 3D wireframe and pinch marker rendered via `InstancedMesh` + `LineSegments`.
   - *Incomplete:* Mapped into a fixed head-relative frustum in front of the viewer rather than unprojected via depth maps or fused with WebXR `XRHand` joints.
8. **Wi-Fi/LAN Sensor Payload Parsing (`src/modules/connectBluetoothAndWifiDevices.ts`):**
   - *Working:* Connects over `ws://`/HTTP, reads BLE GATT `battery_service`, lists statuses, and syncs device entries across room peers.
   - *Incomplete:* Incoming Wi-Fi WebSocket frames are shown only as a raw `RX ...` status snippet.

---

### 📋 1.3. Planned / Not Yet Implemented Features (Roadmap)

- **MediaPipe CPU Delegate Fallback & Offline Assets:** Fallback from `delegate: 'GPU'` to `'CPU'` plus locally hosted `.wasm`/`.tflite` files under `public/` for air-gapped operation.
- **Direct Camera-Hand Pinch Raycast Interaction:** Casting 3D UI/console raycasts directly from the webcam-tracked index finger tip (currently XR `onSelectStart`, mouse clicks, and BT gyro laser trigger clicks).
- **On-Device Offline AI (Transformers.js / WebGPU):** Local NLLB-200 / Opus-MT translation and local Whisper WASM transcription without external API keys.
- **Native USB-C DP-Alt Companion Bridge for Rokid Max 1:** Switching Rokid Max hardware display mode between 2D `1920x1080` and 3D SBS `3840x1080` requires an Android/Desktop OS helper outside browser sandboxes.
- **Voice-Controlled 3D Room Consoles:** Routing STT/LLM intent commands directly to Datacenter, Starship, and Airplane panel switches.

---

## 2. Complete Stub Inventory & Production Replacement Guide

| # | File & Symbol | What Is Stubbed | Production Replacement |
|---|---|---|---|
| 1 | `src/modules/readRokidImuAndProtocol.ts` -> `onHidInputReport()` | Reads generic `float32` offsets `(4,8,12,16)` without firmware unlock `sendFeatureReport` or flash calibration matrices; falls back to `DeviceOrientation`/WebXR. | Integrate **Rokid UXR SDK / OpenHMD** HID parser, 1000Hz feature unlock report, and Android USB-C OTG JNI bridge. |
| 2 | `src/modules/streamCloudEnvironment.ts` -> `setCloudStream()` / `cloudSocket.onmessage` | Falls back to `local-procedural` PBR Three.js scene when no remote GPU server streams frames; WS handler counts bytes without texture decoding. | Attach **WebRTC Pixel Streaming** (`MediaStream` -> `THREE.VideoTexture`) or headless Three.js/Vulkan server decoding frames to `domeMat.map`. |
| 3 | `src/modules/translateTextBetweenLanguages.ts` -> `offline-stub` | Returns `[TARGET_LANG] <text>` (`provider: 'offline-stub'`) when no `llm` endpoint or `GEMINI_API_KEY` is configured. | Configure an OpenAI-compatible `llm` endpoint / `GEMINI_API_KEY`, or load on-device **Transformers.js (NLLB-200 / Opus-MT)** via WebGPU/WASM. |
| 4 | `src/modules/connectBluetoothGyroController.ts` -> `connectVirtualGyroStub()` | `simulated-bt` maps desktop pointer movement, `Space` trigger, and `Alt+C` recenter to the 3D laser pointer when no physical BT hardware is attached. | Use physical Android/Windows **Gamepad API (`gamepad.pose`)** and **Web Bluetooth BLE GATT** notifications; disable virtual stub in release builds. |
| 5 | `src/modules/trackHandsFromCamera.ts` -> `createSimulatedHandState()` | Generates an animated 21-landmark synthetic hand (`isSimulated: true`) for testing the diagnostic overlay without a camera. | Rely exclusively on live MediaPipe `HandLandmarker` or WebXR **`XRHand`** tracking streams. |
| 6 | `src/modules/balanceSpatialAudio.ts` -> `ensureDeviceBus()` | Allocates per-device virtual `DeviceAudioBus` nodes inside the shared `AudioContext` because BLE GATT does not route OS A2DP audio. | Bind `navigator.mediaDevices.enumerateDevices()` (`audiooutput`) with `AudioContext.setSinkId(sinkId)` on desktop or native Android `AudioManager`. |
| 7 | `src/modules/manageDetectionClasses.ts` & `detectObjectsFromCamera.ts` -> `queryVisionEndpointIfEnabled()` | Local MediaPipe only supports 80 COCO classes; custom classes use a Vision LLM prompt with synthetic grid bounding boxes. | Swap to an open-vocabulary ONNX/WebGPU detector (**YOLO-World / GroundingDINO**) or request `[ymin, xmin, ymax, xmax]` JSON boxes from a VLM. |
| 8 | `src/modules/build3dPlacesAndControlPanels.ts` -> `buildDatacenterPlace()`, `buildSpaceshipPlace()`, `buildAirplanePlace()`, `buildCyberLoungePlace()` | Datacenter NOC metrics (°C, PUE, kW), Starship telemetry (Warp, shields, radar), and Airplane avionics (IAS, ALT, N1, gear, flaps) are simulated locally. | Bind `redrawScreen()` & `triggerAction()` to live **Prometheus / SNMP / MQTT** streams or **X-Plane UDP / MSFS SimConnect** WebSocket bridges. |
| 9 | `src/modules/communicatePeerTtsStt.ts` -> `startListening()` | Captures microphone audio only via browser `SpeechRecognition`, bypassing user-configured Whisper `stt` endpoints. | Record audio via `MediaRecorder` / `AudioWorklet` + VAD and POST `FormData` to `/v1/audio/transcriptions` via `/api/proxy` or local `whisper.wasm`. |
| 10 | `server.ts` + `src/modules/communicatePeerTtsStt.ts` -> `rtc:signal` | Server `/ws` relays `rtc:signal`, while client lacks `RTCPeerConnection` and OpenAI Realtime audio session logic. | Implement `RTCPeerConnection` mesh/SFU signaling (`offer`, `answer`, `icecandidate`) and OpenAI Realtime `wss://` streaming. |

---

## 3. Server API & WebSocket (`server.ts`)

- `GET /api/health` — Returns service health and whether `GEMINI_API_KEY` is configured.
- `POST /api/proxy` — CORS-safe HTTP/HTTPS proxy (`{ url, method, headers, data }`) for endpoint testing, `/v1/models`, and LLM/TTS/Vision requests.
- `POST /api/gemini-translate` — Server-side translation backed by `@google/genai` (`gemini-2.5-flash`).
- `WS /ws` — Room synchronization server handling `peer:join`, `peer:update`, `peer:leave`, `peer:list`, `speech:send`, `rtc:signal`, `nav:command`, and `device:sync`.

---

## 4. Setup & Running

```bash
npm install
npm run dev      # Start unified Express + WS + Vite dev server on http://localhost:3000
npm run build    # Build production client bundle (dist/)
npm start        # Start production Express + WS + static dist/ server
```
