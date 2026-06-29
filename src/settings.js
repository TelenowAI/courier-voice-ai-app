// ─────────────────────────────────────────────────────────────────────────────
// settings.js — single-tenant settings model.
//
// There is ONE settings object for the whole service:
//   - telenowApiKey: the merchant's `vai_live_...` key (SECRET — never log it)
//   - automations:   per-use-case config { enabled, agentId, delayMinutes,
//                     quietHours }. Today there is one: `ndrRetry`.
//   - couriers:      { shiprocket: { ndrStatuses[] }, delhivery: { ndrStatusTypes[],
//                      ndrNslCodes[] } } — the configurable NDR matchers.
//   - autoReattempt: when true AND the call disposition asks for a re-attempt,
//                    call the courier's re-attempt API (needs courier creds).
//
// Persistence is delegated to store.js (file stub today, DB tomorrow).
// ─────────────────────────────────────────────────────────────────────────────

import { getSettingsRaw, setSettingsRaw } from './store.js';

/**
 * The canonical list of automations the app ships with. Each has a stable key
 * used in the settings UI and the webhook dispatcher. `triggers` is purely
 * documentation of which courier events drive it.
 */
export const AUTOMATIONS = [
  {
    key: 'ndrRetry',
    label: 'NDR failed-delivery retry by voice',
    triggers: ['Shiprocket NDR webhook', 'Delhivery NDR webhook'],
    defaultDelayMinutes: 0, // speed matters — call ASAP on a failed attempt
  },
];

/** Default NDR matchers per courier (configurable in settings). */
function defaultCouriers() {
  return {
    shiprocket: {
      // current_status (lower-cased) is treated as NDR if it CONTAINS any of these.
      ndrStatuses: ['ndr', 'undelivered', 'undeliverable', 'delivery attempt failed'],
    },
    delhivery: {
      // Shipment.Status.StatusType values treated as NDR (UD = undelivered).
      ndrStatusTypes: ['UD'],
      // Optional NSL codes that also indicate an NDR (substring match, lower-cased).
      ndrNslCodes: ['ndr', 'consignee', 'not available', 'refused', 'address'],
    },
  };
}

/** Build the default config for a single automation. */
function defaultAutomation(def) {
  return {
    enabled: false,
    agentId: '', // Telenow agent UUID — required when enabled
    delayMinutes: def.defaultDelayMinutes ?? 0,
    // Quiet hours: don't place calls within this local window. 24h "HH:MM".
    quietHours: { enabled: false, start: '21:00', end: '09:00', timezone: 'Asia/Kolkata' },
  };
}

/** Build a fresh default settings object. */
export function defaultSettings() {
  const automations = {};
  for (const def of AUTOMATIONS) automations[def.key] = defaultAutomation(def);
  return {
    telenowApiKey: '',
    storeName: '', // shown to the customer by the agent ("calling on behalf of <store>")
    automations,
    couriers: defaultCouriers(),
    // Optional: after a call asks for re-attempt, tell the courier to re-attempt.
    // Gated here AND on the presence of courier creds (see couriers/*.js).
    autoReattempt: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get the settings, filling in any missing automations / courier matchers with
 * defaults so older persisted blobs stay forward-compatible as we add use cases.
 */
export function getSettings() {
  const stored = getSettingsRaw();
  const base = defaultSettings();
  if (!stored) return base;
  const merged = { ...base, ...stored };
  merged.automations = { ...base.automations, ...(stored.automations || {}) };
  for (const def of AUTOMATIONS) {
    merged.automations[def.key] = {
      ...defaultAutomation(def),
      ...(merged.automations[def.key] || {}),
    };
  }
  // Deep-fill courier matchers.
  const dc = defaultCouriers();
  merged.couriers = {
    shiprocket: { ...dc.shiprocket, ...(stored.couriers?.shiprocket || {}) },
    delhivery: { ...dc.delhivery, ...(stored.couriers?.delhivery || {}) },
  };
  return merged;
}

/** Convenience: config for one automation. */
export function getAutomation(key) {
  return getSettings().automations[key];
}

/**
 * Persist a settings update (shallow-merged onto current). Pass only the fields
 * you want to change. Returns the full, merged settings.
 * @param {Partial<ReturnType<typeof defaultSettings>>} patch
 */
export function updateSettings(patch = {}) {
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    automations: { ...current.automations },
    couriers: { ...current.couriers },
    updatedAt: new Date().toISOString(),
  };
  // Deep-merge automations if provided.
  if (patch.automations) {
    for (const [key, cfg] of Object.entries(patch.automations)) {
      next.automations[key] = { ...current.automations[key], ...cfg };
    }
  }
  // Deep-merge courier matchers if provided.
  if (patch.couriers) {
    next.couriers = {
      shiprocket: { ...current.couriers.shiprocket, ...(patch.couriers.shiprocket || {}) },
      delhivery: { ...current.couriers.delhivery, ...(patch.couriers.delhivery || {}) },
    };
  }
  setSettingsRaw(next);
  return next;
}

/**
 * Settings safe to send to the browser settings UI: the API key is masked so we
 * never ship the raw secret to the client.
 */
export function getRedactedSettings() {
  const s = getSettings();
  return {
    ...s,
    telenowApiKey: maskKey(s.telenowApiKey),
    telenowApiKeySet: Boolean(s.telenowApiKey),
  };
}

/** "vai_live_abcd…wxyz" → show only a hint, never the full secret. */
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}
