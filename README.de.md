# Rokid Vision XR Hub — Vollständige Technische Dokumentation (Deutsch)

**Sprachen der Dokumentation:** [English](README.en.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Übersicht](README.md)

**Rokid Vision XR Hub** ist eine modulare WebXR-Plattform für räumliches Sehen, ML-Objekterkennung, Hand- und Kopfgesten-Tracking, Stereorendering, Bluetooth-Gyro-Controller, prozedurale 3D-Räume und übersetzte Sprachkommunikation („Any-to-Any“). Basierend auf **XR Blocks (`~0.24.0`)**, **Three.js (`~0.186.0`)**, **MediaPipe Tasks Vision (`@mediapipe/tasks-vision`)** und **Express + WebSocket (`ws`)**.

Unterstützt **Android-Kameras**, **Desktop-/USB-Webcams**, **VR-Headsets**, **Android/Windows Bluetooth-Gyro-Controller** und **Rokid Max (1. Generation)** AR-Brillen.

---

## 1. Funktionsstatus-Matrix

### ✅ 1.1. Vollständig implementierte Funktionen

| Teilsystem | Implementierter Funktionsumfang | Quelldateien |
|---|---|---|
| **Core Runtime & XR-Szene** | Striktes Vanilla-TypeScript (`xb.Script`), XR Blocks Initialisierung (`enableHands`, `enableHeadGestures`, `enableReticles`, `enableObjectDetection`), Render-Loop & Ressourcenfreigabe (`dispose`). | `src/index.ts`, `src/xr/SpatialVisionScene.ts` |
| **Android- & USB-Webcams** | Front-/Rückkamera auf Android & externe USB-Webcams (`enumerateDevices()`, Hot-Plug `devicechange`), Auflösungen `480p`/`720p`/`1080p`, Spiegelung, `{ video: true }`-Fallback-Kette und schwebendes 3D-`THREE.VideoTexture`-Vorschaupanel. | `src/modules/detectObjectsFromCamera.ts` |
| **Echtzeit-ML-Objekterkennung** | MediaPipe `ObjectDetector` (`efficientdet_lite0.tflite`, GPU-Delegate, `VIDEO`-Modus) mit normalisierten Bounding Boxes und Konfidenzwerten sowie optionaler Abfrage eines OpenAI-kompatiblen `vision`-Endpunkts. | `src/modules/detectObjectsFromCamera.ts` |
| **Objektklassen-Manager (Detection Objects)** | Dashboard-Filterkarte für 4 Kategorien (`furniture`, `personal`, `electronics`, `environment`), Klassensuche, Modi „Alle Klassen“ / „Benutzerdefiniert“, dynamisches MediaPipe-`categoryAllowlist` per `setOptions()`, Synonyme und eigene Klassen. | `src/modules/manageDetectionClasses.ts`, `src/ui/renderControlHud.ts` |
| **Handtracking & Visuelles Diagnose-Overlay** | MediaPipe `HandLandmarker` (21 3D-Landmarken), Pinch-Distanzberechnung, Gestenklassifikation (`Pinch`, `Open Palm`, `Point`, `Fist`, `Victory`), schwebendes `#hand-diag-overlay` mit Knochenskelett, IDs `#0–20`, Pinch-Vektor & `0–100%`-Konfidenzbalken sowie 3D-Skelett (`InstancedMesh` + `LineSegments`). | `src/modules/trackHandsFromCamera.ts`, `src/modules/renderHandDiagnosticOverlay.ts` |
| **Berührungslose Kopfgesten-UI** | Kombination aus XR Blocks `xb.core.input.headGestures` und IMU-Winkelverlauf: `nod` (HUD öffnen / Scan), `shake` (HUD einklappen), `tilt_left` / `tilt_right` (Tabs wechseln) inkl. Cooldown-Schutz. | `src/modules/recognizeHeadGestures.ts` |
| **Anzeigemodi & Stereorendering** | Automatische Auswahl und manueller Wechsel zwischen `Monoscopic`, `SBS 3D-Stereo` (`THREE.StereoCamera` mit IPD 54–74 mm & Dual-Viewport-Scissor-Rendering) und `360°-Kuppel`. | `src/modules/switchViewingMode.ts` |
| **Fern- & Lokalnavigation** | Exponentiell gedämpfte (`THREE.MathUtils.damp`) `worldRig`-Bewegung und Yaw-Drehung (`forward`, `back`, `left`, `right`, `reset`) per HUD, Tastatur (`WASD`/Pfeile/`R`) und WebSocket `nav:command`. | `src/modules/navigateRemotely.ts` |
| **BT-Gyro-Controller & 3D-Laserpointer** | Standard-Android-/Windows-Bluetooth-Controller über Web Gamepad API (`gamepad.pose` & Analog-Sticks) und Web Bluetooth BLE GATT, Rezentrierung, Empfindlichkeitsregler, volumetrischer 3D-Laserstrahl mit Trefferpunkt sowie Klick-Trigger auf `xb.UIButton` und 3D-Pulttasten. | `src/modules/connectBluetoothGyroController.ts`, `src/xr/SpatialVisionScene.ts` |
| **Prozedurale 3D-Räume & Kontrollpulte** | 5 verzögerungsfrei (lazy) gebaute Zero-404-Räume: `calibration_lab`, `datacenter` (NOC-Pult, 42U-Racks, `InstancedMesh`-LEDs, Lüfter), `spaceship` (Warp-Sterne, Ringplanet, Schildkugel, Brückenpult & Radar), `airplane` (Cockpit mit PFD/ND/EICAS-Avionik, Steuerhörnern, Schubhebeln, MCP-Autopilot) und `cyber_lounge` (Hologramm-Stadt). | `src/modules/build3dPlacesAndControlPanels.ts` |
| **Verwaltung eigener Endpunkte** | Unbegrenztes CRUD (Hinzufügen, Editieren, Einzeln/Alle löschen, Aktivieren) für `llm`, `stt`, `tts`, `vision`, `rtc`, `cloud_render` inkl. `localStorage`-Persistenz, **Verbindungstest** und **Modellliste laden** (`/v1/models`) über `/api/proxy`. | `src/modules/manageCustomEndpoints.ts`, `server.ts` |
| **Any-to-Any Peer-Kommunikation (TTS/STT)** | Mehrbenutzer-WebSocket-Räume `/ws` (`peer:join`, `peer:update`, `peer:leave`, `peer:list`, `speech:send`), Adressierung an `all` oder `toPeerId`, Sofortübersetzung zwischen 9 Sprachen, `SpeechRecognition`-Aufnahme und TTS (`speechSynthesis` / OpenAI `/v1/audio/speech`). | `server.ts`, `src/modules/communicatePeerTtsStt.ts`, `src/modules/translateTextBetweenLanguages.ts` |
| **Leistungs- & Akkudiagnose** | Echtzeit-FPS, Frame-Zeit (ms), WebGL Draw Calls, Dreiecke, Geometrien/Texturen, JS-Heap (`performance.memory`), ML/IMU-Latenzen, thermische Heuristik und Battery Status API (`navigator.getBattery()`). | `src/modules/monitorPerformanceAndBattery.ts` |
| **Vollständige Lokalisierung EN / RU / DE** | Sofortige Sprachumschaltung für alle 2D-HUD-Tabs, das Hand-Diagnose-Overlay und alle 3D-`xb.UICard`-Elemente. | `src/modules/localizeInterface.ts` |

---

### 🟡 1.2. Teilweise implementierte Funktionen (Hardware- / Browser-Einschränkungen)

1. **Rokid Max 1st Gen USB-HID-Kalibrierungsprotokoll (`src/modules/readRokidImuAndProtocol.ts`):**
   - *Funktioniert:* Automatische Headset-Erkennung per User-Agent & `32:9` (`3840x1080`) Seitenverhältnis, WebHID-Auswahl (`VID 0x04D2` / `0x2833`), `inputreport`-Auswertung sowie Sensorfusion mit `DeviceOrientation`/`DeviceMotion`/WebXR inkl. SLERP-Stabilisierung.
   - *Unvollständig:* Keine proprietären `sendFeatureReport`-Aktivierungsbefehle (z. B. 1000-Hz-IMU-Freischaltung) und kein Auslesen der werkseitigen Flash-Kalibrierungsmatrizen.
2. **Aufruf benutzerdefinierter Whisper-STT-Endpunkte (`src/modules/communicatePeerTtsStt.ts`):**
   - *Funktioniert:* Vollständiges CRUD, Verbindungstest und `/v1/models`-Abfrage für `stt`-Endpunkte sowie Spracherkennung über die Browser-`SpeechRecognition`.
   - *Unvollständig:* `startListening()` nimmt noch keine Audio-Blobs über `MediaRecorder` / `AudioWorklet` auf, um sie per `multipart/form-data` an `/v1/audio/transcriptions` zu senden; die Mikrofoneingabe läuft ausschließlich über Web Speech `SpeechRecognition`.
3. **WebRTC Peer-to-Peer Audio/Video-Streams (`server.ts`, `src/modules/communicatePeerTtsStt.ts`):**
   - *Funktioniert:* Der Server `/ws` leitet `rtc:signal`-Pakete weiter, und `manageCustomEndpoints.ts` testet `wss://`-RTC-URLs.
   - *Unvollständig:* Auf Client-Seite existiert noch kein `RTCPeerConnection`-Manager zur Aushandlung von Offer/Answer/ICE-Kandidaten; Sprachnachrichten laufen aktuell über `STT -> Übersetzung -> WS-Text -> TTS`.
4. **Dekodierung von Cloud-3D-Render-Videoströmen (`src/modules/streamCloudEnvironment.ts`):**
   - *Funktioniert:* Verbindungsaufbau über `ws://`/`wss://` oder HTTP, Zählung von `frameCount` & `bitrateKbps` sowie lokaler prozeduraler PBR-Fallback.
   - *Unvollständig:* Eingehende WebSocket-Frames in `cloudSocket.onmessage` werden gezählt, aber noch nicht in `THREE.Texture` / `VideoFrame` auf `domeMat.map` dekodiert.
5. **Physisches Audio-Routing pro Bluetooth-Gerät (`src/modules/balanceSpatialAudio.ts`):**
   - *Funktioniert:* Web Audio API (`HRTF` `PannerNode`, `StereoPannerNode`, `GainNode`), kamera-gekoppelter `AudioListener`, virtuelle Busse pro BT-Gerät (`DeviceAudioBus`) und 3D-Testton.
   - *Unvollständig:* `window.speechSynthesis` umgeht den Web-Audio-Graphen, `getEffectiveVolumeForTts()` wird noch nicht an `<audio>.volume` / `utterance.volume` übergeben, und `AudioContext.setSinkId()` ist noch nicht an OS-A2DP-Ausgabegeräte gebunden.
6. **Bounding-Box-Koordinaten bei Vision-LLM-Abfragen (`src/modules/detectObjectsFromCamera.ts`):**
   - *Funktioniert:* Benutzerdefinierte Nicht-COCO-Klassen werden in den Vision-LLM-Prompt injiziert.
   - *Unvollständig:* Da Text-VLMs nur Labels zurückgeben, werden synthetische Raster-Boxen (`bbox: [0.15 + i * 0.18, ...]`) statt echter Pixel-Koordinaten erzeugt.
7. **Welt-verankerte 3D-Handprojektion (`src/xr/SpatialVisionScene.ts`):**
   - *Funktioniert:* Vollständiges 21-Punkte-3D-Drahtgitter (`InstancedMesh` + `LineSegments`) vor der Kamera.
   - *Unvollständig:* Projektion nutzt einen festen Sichtbereich vor dem Kopf statt Tiefenmap-Unprojection oder nativer WebXR-`XRHand`-Joint-Posen.
8. **Wi-Fi/LAN-Sensordaten-Parser (`src/modules/connectBluetoothAndWifiDevices.ts`):**
   - *Funktioniert:* `ws://`/HTTP-Verbindung, BLE-GATT-`battery_service`-Abfrage und raumweite Gerätesynchronisierung.
   - *Unvollständig:* Eingehende Wi-Fi-WebSocket-Nachrichten werden nur als Rohtext (`RX ...`) im HUD angezeigt.

---

### 📋 1.3. Geplante, noch nicht umgesetzte Funktionen (Roadmap)

- **MediaPipe CPU-Delegate-Fallback & Offline-Assets:** Automatischer Fallback von `delegate: 'GPU'` auf `'CPU'` sowie lokale `.wasm`/`.tflite`-Dateien unter `public/` für Offline-Betrieb.
- **Direkte Pinch-Raycast-Klicks aus Webcam-Handtracking:** Auslösen von Klicks auf 3D-UI-Karten und Konsolen per Webcam-Pinch (aktuell über WebXR-`onSelectStart`, Maus oder BT-Laser-Trigger).
- **Lokale Offline-KI (Transformers.js / WebGPU):** Lokale NLLB-200/Opus-MT-Übersetzung und lokales `whisper.wasm` ohne Cloud-API-Schlüssel.
- **Nativer USB-C DP-Alt Begleitdienst für Rokid Max 1:** Hardware-Umschaltung `1920x1080 <-> 3840x1080 SBS` über eine native Android-/Desktop-Bridge außerhalb der Browser-Sandbox.
- **Sprachsteuerung der 3D-Kontrollpulte:** Direkte Verknüpfung von STT/LLM-Intents mit den Schaltern in Rechenzentrum, Raumschiff und Flugzeug-Cockpit.

---

## 2. Vollständiges Verzeichnis aller Stubs (Platzhalter) & Produktiv-Ersatz

| Nr. | Datei & Funktion | Was ist ein Stub (Platzhalter)? | Ersatz im Produktivcode |
|---|---|---|---|
| 1 | `src/modules/readRokidImuAndProtocol.ts` -> `onHidInputReport()` | Liest feste `float32`-Offsets `(4,8,12,16)` ohne Firmware-Handshake (`sendFeatureReport`) oder Flash-Kalibrierungsmatrizen; fällt auf `DeviceOrientation`/WebXR zurück. | **Rokid UXR SDK / OpenHMD** HID-Parser, 1000-Hz-Unlock-Report und native Android USB-C OTG JNI-Bridge. |
| 2 | `src/modules/streamCloudEnvironment.ts` -> `setCloudStream()` / `cloudSocket.onmessage` | Fällt ohne externen GPU-Server auf `local-procedural` PBR zurück; WS-Handler zählt nur Bytes statt Videoframes zu dekodieren. | **WebRTC Pixel Streaming** (`MediaStream` -> `THREE.VideoTexture`) oder Headless-Three.js/Vulkan-Server mit Video-Dekodierung auf `domeMat.map`. |
| 3 | `src/modules/translateTextBetweenLanguages.ts` -> `offline-stub` | Gibt `[TARGET_LANG] <Text>` (`provider: 'offline-stub'`) zurück, wenn kein `llm`-Key und kein `GEMINI_API_KEY` vorhanden sind. | OpenAI-kompatiblen `llm`-Endpunkt / `GEMINI_API_KEY` konfigurieren oder **Transformers.js (NLLB-200 / Opus-MT)** via WebGPU/WASM einbinden. |
| 4 | `src/modules/connectBluetoothGyroController.ts` -> `connectVirtualGyroStub()` | `simulated-bt` emuliert einen 3DoF-BT-Controller über Mausbewegung, `Space` und `Alt+C` für Desktop-Tests ohne physische Hardware. | Echte Android/Windows **Gamepad API (`gamepad.pose`)** und **Web Bluetooth BLE GATT**-Streams nutzen; Emulator im Release deaktivieren. |
| 5 | `src/modules/trackHandsFromCamera.ts` -> `createSimulatedHandState()` | Erzeugt ein animiertes 21-Punkte-Testskelett (`isSimulated: true`), um das Diagnose-Overlay ohne Kamera zu prüfen. | Produktiv ausschließlich Live-Daten von MediaPipe `HandLandmarker` oder WebXR **`XRHand`** verwenden. |
| 6 | `src/modules/balanceSpatialAudio.ts` -> `ensureDeviceBus()` | Erstellt virtuelle `DeviceAudioBus`-Knoten im gemeinsamen `AudioContext`, da BLE GATT keine OS-A2DP-Ausgänge routet. | `navigator.mediaDevices.enumerateDevices()` (`audiooutput`) + `AudioContext.setSinkId(sinkId)` bzw. natives Android `AudioManager`-Routing nutzen. |
| 7 | `src/modules/manageDetectionClasses.ts` & `detectObjectsFromCamera.ts` -> `queryVisionEndpointIfEnabled()` | Lokales MediaPipe kennt nur 80 COCO-Klassen; eigene Klassen nutzen einen Vision-LLM-Prompt mit synthetischen Bounding Boxes. | Auf Open-Vocabulary-Detektor (**YOLO-World / GroundingDINO** via ONNX/WebGPU) oder JSON-Koordinaten `[ymin, xmin, ymax, xmax]` vom VLM umstellen. |
| 8 | `src/modules/build3dPlacesAndControlPanels.ts` -> `buildDatacenterPlace()`, `buildSpaceshipPlace()`, `buildAirplanePlace()`, `buildCyberLoungePlace()` | Rechenzentrum-Werte (°C, PUE, kW), Raumschiff-Systeme (Warp, Schilde, Radar) und Flugzeug-Avionik (IAS, ALT, N1, Fahrwerk, Klappen) sind lokal simuliert. | `redrawScreen()` & `triggerAction()` an **Prometheus / SNMP / MQTT** bzw. **X-Plane UDP / MSFS SimConnect** anbinden. |
| 9 | `src/modules/communicatePeerTtsStt.ts` -> `startListening()` | Nutzt nur `SpeechRecognition` des Browsers und ruft noch keine eigenen Whisper-`stt`-Endpunkte auf. | Mikrofon mit `MediaRecorder` / `AudioWorklet` + VAD aufnehmen und per `FormData` an `/v1/audio/transcriptions` über `/api/proxy` oder lokales `whisper.wasm` senden. |
| 10 | `server.ts` + `src/modules/communicatePeerTtsStt.ts` -> `rtc:signal` | Server `/ws` leitet `rtc:signal` weiter, aber im Client fehlt die `RTCPeerConnection`- und OpenAI-Realtime-Verhandlung. | Vollständigen `RTCPeerConnection`-Manager (`offer`, `answer`, `icecandidate`) und OpenAI Realtime `wss://`-Audiostreaming implementieren. |

---

## 3. Server-API & WebSocket (`server.ts`)

- `GET /api/health` — Serverstatus und `GEMINI_API_KEY`-Verfügbarkeit.
- `POST /api/proxy` — CORS-freier HTTP/HTTPS-Proxy (`{ url, method, headers, data }`) für Endpunkttests, `/v1/models` und LLM/TTS/Vision-Aufrufe.
- `POST /api/gemini-translate` — Serverseitige Übersetzung über `@google/genai` (`gemini-2.5-flash`).
- `WS /ws` — Sitzungsräume für `peer:join`, `peer:update`, `peer:leave`, `peer:list`, `speech:send`, `rtc:signal`, `nav:command`, `device:sync`.

---

## 4. Installation & Start

```bash
npm install
npm run dev      # Express + WS + Vite Dev-Server auf http://localhost:3000
npm run build    # Produktions-Build (dist/)
npm start        # Produktionsserver mit statischem dist/ & /ws
```
