/**
 * Модуль подключения стандартных Bluetooth и Wi-Fi устройств (connectBluetoothAndWifiDevices).
 *
 * Назначение:
 * 1. Поиск и сопряжение стандартных устройств Bluetooth LE через Web Bluetooth API
 *    (`navigator.bluetooth.requestDevice`) с чтением стандартных GATT-сервисов
 *    (Battery Service, Heart Rate, Device Information, Generic Access / Custom UART);
 * 2. Подключение к локальным Wi-Fi / LAN-устройствам (по WebSocket ws:// или HTTP-опросу)
 *    и синхронизация данных между платформами через общий WebSocket-канал сессии.
 *
 * Входные параметры:
 * - wifiUrl: string — адрес Wi-Fi/LAN-устройства или шлюза;
 * - onSyncBroadcast: callback для ретрансляции телеметрии устройства другим участникам сессии.
 *
 * Выходные данные:
 * - Реактивный список подключенных WirelessDeviceEntry[].
 */

import type { WirelessDeviceEntry } from '../types';

export interface WirelessDeviceHub {
  getDevices(): WirelessDeviceEntry[];
  pairBluetoothDevice(): Promise<WirelessDeviceEntry>;
  connectWifiDevice(url: string): Promise<WirelessDeviceEntry>;
  registerUsbHidDevice(name: string, detail: string): void;
  pushExternalSync(entry: WirelessDeviceEntry): void;
  subscribe(cb: (devices: WirelessDeviceEntry[]) => void): () => void;
  dispose(): void;
}

export function createWirelessDeviceHub(
  onBroadcastDevice?: (device: WirelessDeviceEntry) => void
): WirelessDeviceHub {
  const devices = new Map<string, WirelessDeviceEntry>();
  const sockets = new Map<string, WebSocket>();
  const listeners = new Set<(list: WirelessDeviceEntry[]) => void>();

  function notify(): void {
    const list = Array.from(devices.values());
    for (const cb of listeners) cb(list);
  }

  function upsert(entry: WirelessDeviceEntry, broadcast = true): void {
    devices.set(entry.id, entry);
    notify();
    if (broadcast) {
      onBroadcastDevice?.(entry);
    }
  }

  async function pairBluetoothDevice(): Promise<WirelessDeviceEntry> {
    const navBt = navigator as Navigator & {
      bluetooth?: {
        requestDevice(opts: {
          acceptAllDevices: boolean;
          optionalServices: string[];
        }): Promise<{
          id: string;
          name?: string;
          gatt?: {
            connect(): Promise<{
              connected: boolean;
              getPrimaryService?(svc: string): Promise<{
                getCharacteristic?(ch: string): Promise<{
                  readValue(): Promise<DataView>;
                }>;
              }>;
            }>;
          };
          addEventListener(ev: string, cb: () => void): void;
        }>;
      };
    };

    if (!navBt.bluetooth) {
      const errEntry: WirelessDeviceEntry = {
        id: `bt-err-${Date.now()}`,
        name: 'Web Bluetooth API',
        transport: 'bluetooth',
        status: 'error',
        detail: 'Требуется HTTPS и браузер Chrome/Android с поддержкой Web Bluetooth',
        lastSyncAt: Date.now(),
      };
      upsert(errEntry, false);
      return errEntry;
    }

    try {
      const device = await navBt.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          'battery_service',
          'device_information',
          'generic_access',
          'heart_rate',
          '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service
        ],
      });

      let detail = 'BLE paired';
      if (device.gatt) {
        const server = await device.gatt.connect();
        detail = server.connected ? 'GATT connected' : 'Paired';
        try {
          const battSvc = await server.getPrimaryService?.('battery_service');
          const battChar = await battSvc?.getCharacteristic?.('battery_level');
          const val = await battChar?.readValue();
          if (val && val.byteLength > 0) {
            detail = `GATT connected • Battery ${val.getUint8(0)}%`;
          }
        } catch {
          // Устройство может не предоставлять стандартный сервис батареи
        }
      }

      const entry: WirelessDeviceEntry = {
        id: `bt-${device.id}`,
        name: device.name || 'Bluetooth Device',
        transport: 'bluetooth',
        status: 'connected',
        detail,
        lastSyncAt: Date.now(),
      };

      device.addEventListener('gattserverdisconnected', () => {
        upsert(
          {
            ...entry,
            status: 'disconnected',
            detail: 'GATT disconnected',
            lastSyncAt: Date.now(),
          },
          true
        );
      });

      upsert(entry, true);
      return entry;
    } catch (error) {
      const errEntry: WirelessDeviceEntry = {
        id: `bt-cancel-${Date.now()}`,
        name: 'Bluetooth',
        transport: 'bluetooth',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
        lastSyncAt: Date.now(),
      };
      upsert(errEntry, false);
      return errEntry;
    }
  }

  async function connectWifiDevice(rawUrl: string): Promise<WirelessDeviceEntry> {
    const url = rawUrl.trim();
    const id = `wifi-${url}`;

    if (/^wss?:\/\//i.test(url)) {
      return new Promise((resolve) => {
        try {
          const ws = new WebSocket(url);
          sockets.set(id, ws);
          ws.onopen = () => {
            const entry: WirelessDeviceEntry = {
              id,
              name: url.replace(/^wss?:\/\//i, ''),
              transport: 'wifi',
              status: 'streaming',
              detail: 'Wi-Fi WebSocket stream active',
              lastSyncAt: Date.now(),
            };
            upsert(entry, true);
            resolve(entry);
          };
          ws.onmessage = (msg) => {
            const existing = devices.get(id);
            if (existing) {
              upsert(
                {
                  ...existing,
                  status: 'streaming',
                  detail: `RX ${String(msg.data).slice(0, 48)}`,
                  lastSyncAt: Date.now(),
                },
                false
              );
            }
          };
          ws.onerror = () => {
            const entry: WirelessDeviceEntry = {
              id,
              name: url,
              transport: 'wifi',
              status: 'error',
              detail: 'Wi-Fi WS connection failed',
              lastSyncAt: Date.now(),
            };
            upsert(entry, false);
            resolve(entry);
          };
        } catch (err) {
          const entry: WirelessDeviceEntry = {
            id,
            name: url,
            transport: 'wifi',
            status: 'error',
            detail: err instanceof Error ? err.message : String(err),
            lastSyncAt: Date.now(),
          };
          upsert(entry, false);
          resolve(entry);
        }
      });
    }

    // Проверка HTTP Wi-Fi/LAN-устройства через серверный прокси
    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: 'GET' }),
      });
      const json = (await res.json()) as { ok?: boolean; latencyMs?: number; error?: string };
      const entry: WirelessDeviceEntry = {
        id,
        name: url.replace(/^https?:\/\//i, ''),
        transport: 'wifi',
        status: json.ok ? 'connected' : 'error',
        detail: json.ok
          ? `Wi-Fi HTTP OK (${json.latencyMs ?? 0} ms)`
          : json.error || 'Unreachable LAN endpoint',
        lastSyncAt: Date.now(),
      };
      upsert(entry, Boolean(json.ok));
      return entry;
    } catch (error) {
      const entry: WirelessDeviceEntry = {
        id,
        name: url,
        transport: 'wifi',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
        lastSyncAt: Date.now(),
      };
      upsert(entry, false);
      return entry;
    }
  }

  return {
    getDevices: () => Array.from(devices.values()),
    pairBluetoothDevice,
    connectWifiDevice,
    registerUsbHidDevice: (name: string, detail: string) => {
      upsert(
        {
          id: `usb-${name}`,
          name,
          transport: 'usb-hid',
          status: 'streaming',
          detail,
          lastSyncAt: Date.now(),
        },
        true
      );
    },
    pushExternalSync: (entry: WirelessDeviceEntry) => {
      upsert(
        {
          ...entry,
          id: `remote-${entry.id}`,
          detail: `[Synced] ${entry.detail}`,
        },
        false
      );
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: () => {
      for (const ws of sockets.values()) {
        ws.close();
      }
      sockets.clear();
    },
  };
}
