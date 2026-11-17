/**
 * Модуль управления отслеживаемыми классами объектов ML-детекции (manageDetectionClasses).
 *
 * Назначение:
 * Позволяет пользователю гибко включать и отключать конкретные классы объектов
 * (мебель: стулья, столы; личные вещи: рюкзаки, бутылки, книги; электроника; люди и окружение),
 * а также добавлять собственные текстовые классы для Vision LLM-эндпоинтов.
 *
 * Особенности реализации:
 * 1. Предоставляет структурированный каталог стандартных COCO-классов MediaPipe EfficientDet-Lite0,
 *    сгруппированный по категориям (`furniture`, `personal`, `electronics`, `environment`).
 * 2. Поддерживает режим отслеживания всех классов (`trackAllClasses: true`) или выборочный
 *    белый список (`categoryAllowlist`) для ускорения и очистки вывода ML-модели.
 * 3. Фильтрует потоки детекций из любых источников (`mediapipe`, `vision-endpoint`, `xrblocks`)
 *    с учетом синонимов (например, `table` <-> `dining table`, `sofa` <-> `couch`, `phone` <-> `cell phone`).
 *
 * ЗАГЛУШКА / ОГРАНИЧЕНИЕ ЛОКАЛЬНОЙ МОДЕЛИ:
 * Стандартная модель MediaPipe `efficientdet_lite0.tflite` обучена на 80 классах датасета COCO.
 * Если пользователь добавляет произвольный класс вне COCO (например, `keys` или `glasses`),
 * локальный MediaPipe не сможет распознать его напрямую — такие пользовательские классы
 * автоматически передаются в промпт подключенного OpenAI-совместимого `vision`-эндпоинта.
 * Для распознавания произвольных классов на устройстве без облака в продакшне следует
 * заменить модель на открыто-словарный детектор (например, YOLO-World / GroundingDINO ONNX/WebGPU).
 *
 * Входные параметры:
 * - settings: DetectionObjectsSettings — текущее состояние фильтра классов.
 *
 * Выходные данные:
 * - Контроллер `DetectionClassManager` с методами переключения классов, групп,
 *   получения allowlist для MediaPipe и фильтрации `DetectedEntity[]`.
 */

import type {
  DetectedEntity,
  DetectionClassGroupId,
  DetectionObjectsSettings,
} from '../types';

export interface DetectionClassGroup {
  id: DetectionClassGroupId;
  classes: string[];
}

export const DETECTION_CLASS_CATALOG: DetectionClassGroup[] = [
  {
    id: 'furniture',
    classes: ['chair', 'couch', 'dining table', 'bed', 'bench', 'toilet'],
  },
  {
    id: 'personal',
    classes: [
      'backpack',
      'handbag',
      'suitcase',
      'umbrella',
      'bottle',
      'cup',
      'book',
      'scissors',
      'toothbrush',
    ],
  },
  {
    id: 'electronics',
    classes: [
      'laptop',
      'cell phone',
      'keyboard',
      'mouse',
      'remote',
      'tv',
      'clock',
      'microwave',
    ],
  },
  {
    id: 'environment',
    classes: ['person', 'potted plant', 'vase', 'bicycle', 'car', 'dog', 'cat'],
  },
];

export const ALL_CATALOG_CLASSES: string[] = DETECTION_CLASS_CATALOG.flatMap(
  (g) => g.classes
);

const CLASS_SYNONYMS: Record<string, string[]> = {
  'dining table': ['table', 'desk', 'dining table'],
  couch: ['sofa', 'couch'],
  'cell phone': ['phone', 'smartphone', 'mobile', 'cell phone'],
  tv: ['television', 'monitor', 'screen', 'tv'],
  'potted plant': ['plant', 'potted plant'],
};

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export interface DetectionClassManager {
  getCatalogGroups(): DetectionClassGroup[];
  getAllKnownClasses(settings: DetectionObjectsSettings): string[];
  isClassEnabled(settings: DetectionObjectsSettings, label: string): boolean;
  isGroupFullyEnabled(
    settings: DetectionObjectsSettings,
    groupId: DetectionClassGroupId
  ): boolean;
  setTrackAll(
    settings: DetectionObjectsSettings,
    trackAll: boolean
  ): DetectionObjectsSettings;
  toggleClass(
    settings: DetectionObjectsSettings,
    label: string
  ): DetectionObjectsSettings;
  toggleGroup(
    settings: DetectionObjectsSettings,
    groupId: DetectionClassGroupId,
    enable?: boolean
  ): DetectionObjectsSettings;
  selectAll(settings: DetectionObjectsSettings): DetectionObjectsSettings;
  clearAll(settings: DetectionObjectsSettings): DetectionObjectsSettings;
  addCustomClass(
    settings: DetectionObjectsSettings,
    label: string
  ): DetectionObjectsSettings;
  removeCustomClass(
    settings: DetectionObjectsSettings,
    label: string
  ): DetectionObjectsSettings;
  getMediaPipeAllowlist(settings: DetectionObjectsSettings): string[] | null;
  filterEntities(
    settings: DetectionObjectsSettings,
    entities: DetectedEntity[]
  ): DetectedEntity[];
}

export function createDetectionClassManager(): DetectionClassManager {
  function getAllKnownClasses(settings: DetectionObjectsSettings): string[] {
    const set = new Set<string>([...ALL_CATALOG_CLASSES, ...settings.customClasses]);
    return Array.from(set);
  }

  function isClassEnabled(
    settings: DetectionObjectsSettings,
    label: string
  ): boolean {
    if (settings.trackAllClasses) return true;
    const norm = normalizeLabel(label);
    return settings.enabledClasses.some((c) => normalizeLabel(c) === norm);
  }

  function isGroupFullyEnabled(
    settings: DetectionObjectsSettings,
    groupId: DetectionClassGroupId
  ): boolean {
    if (settings.trackAllClasses) return true;
    const group = DETECTION_CLASS_CATALOG.find((g) => g.id === groupId);
    if (!group) return false;
    return group.classes.every((cls) => isClassEnabled(settings, cls));
  }

  function setTrackAll(
    settings: DetectionObjectsSettings,
    trackAll: boolean
  ): DetectionObjectsSettings {
    return {
      ...settings,
      trackAllClasses: trackAll,
    };
  }

  function toggleClass(
    settings: DetectionObjectsSettings,
    label: string
  ): DetectionObjectsSettings {
    const norm = normalizeLabel(label);
    // Если раньше был включен режим "все классы", при точечном отключении переходим к явному списку
    const baseList = settings.trackAllClasses
      ? getAllKnownClasses(settings)
      : [...settings.enabledClasses];

    const exists = baseList.some((c) => normalizeLabel(c) === norm);
    const nextEnabled = exists
      ? baseList.filter((c) => normalizeLabel(c) !== norm)
      : [...baseList, norm];

    return {
      ...settings,
      trackAllClasses: false,
      enabledClasses: nextEnabled,
    };
  }

  function toggleGroup(
    settings: DetectionObjectsSettings,
    groupId: DetectionClassGroupId,
    enable?: boolean
  ): DetectionObjectsSettings {
    const group = DETECTION_CLASS_CATALOG.find((g) => g.id === groupId);
    if (!group) return settings;

    const currentlyFull = isGroupFullyEnabled(settings, groupId);
    const shouldEnable = enable ?? !currentlyFull;

    const baseList = settings.trackAllClasses
      ? getAllKnownClasses(settings)
      : [...settings.enabledClasses];
    const nextSet = new Set(baseList.map(normalizeLabel));

    for (const cls of group.classes) {
      const norm = normalizeLabel(cls);
      if (shouldEnable) {
        nextSet.add(norm);
      } else {
        nextSet.delete(norm);
      }
    }

    return {
      ...settings,
      trackAllClasses: false,
      enabledClasses: Array.from(nextSet),
    };
  }

  function selectAll(
    settings: DetectionObjectsSettings
  ): DetectionObjectsSettings {
    return {
      ...settings,
      trackAllClasses: false,
      enabledClasses: getAllKnownClasses(settings),
    };
  }

  function clearAll(
    settings: DetectionObjectsSettings
  ): DetectionObjectsSettings {
    return {
      ...settings,
      trackAllClasses: false,
      enabledClasses: [],
    };
  }

  function addCustomClass(
    settings: DetectionObjectsSettings,
    label: string
  ): DetectionObjectsSettings {
    const norm = normalizeLabel(label);
    if (!norm) return settings;

    const customExists = settings.customClasses.some(
      (c) => normalizeLabel(c) === norm
    );
    const catalogExists = ALL_CATALOG_CLASSES.some(
      (c) => normalizeLabel(c) === norm
    );
    const nextCustom =
      customExists || catalogExists
        ? settings.customClasses
        : [...settings.customClasses, norm];

    const nextEnabledSet = new Set(settings.enabledClasses.map(normalizeLabel));
    nextEnabledSet.add(norm);

    return {
      ...settings,
      customClasses: nextCustom,
      enabledClasses: Array.from(nextEnabledSet),
    };
  }

  function removeCustomClass(
    settings: DetectionObjectsSettings,
    label: string
  ): DetectionObjectsSettings {
    const norm = normalizeLabel(label);
    return {
      ...settings,
      customClasses: settings.customClasses.filter(
        (c) => normalizeLabel(c) !== norm
      ),
      enabledClasses: settings.enabledClasses.filter(
        (c) => normalizeLabel(c) !== norm
      ),
    };
  }

  function getMediaPipeAllowlist(
    settings: DetectionObjectsSettings
  ): string[] | null {
    if (settings.trackAllClasses) return null;
    return [...settings.enabledClasses];
  }

  function matchesAllowedLabel(
    detectedLabel: string,
    enabledSet: Set<string>
  ): boolean {
    const norm = normalizeLabel(detectedLabel);
    if (enabledSet.has(norm)) return true;

    for (const enabled of enabledSet) {
      const synonyms = CLASS_SYNONYMS[enabled];
      if (synonyms && synonyms.includes(norm)) return true;
      if (norm.includes(enabled) || enabled.includes(norm)) return true;
    }
    return false;
  }

  function filterEntities(
    settings: DetectionObjectsSettings,
    entities: DetectedEntity[]
  ): DetectedEntity[] {
    if (settings.trackAllClasses) return entities;
    if (settings.enabledClasses.length === 0) return [];
    const enabledSet = new Set(settings.enabledClasses.map(normalizeLabel));
    return entities.filter((e) => matchesAllowedLabel(e.label, enabledSet));
  }

  return {
    getCatalogGroups: () => DETECTION_CLASS_CATALOG,
    getAllKnownClasses,
    isClassEnabled,
    isGroupFullyEnabled,
    setTrackAll,
    toggleClass,
    toggleGroup,
    selectAll,
    clearAll,
    addCustomClass,
    removeCustomClass,
    getMediaPipeAllowlist,
    filterEntities,
  };
}
