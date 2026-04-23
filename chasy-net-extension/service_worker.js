// Proxy Switcher service worker (MV3)
// Features: profiles, light/dark settings, import/export, encrypted credentials vault,
// runtime status, connectivity tests, and basic per-site / per-ip routing via PAC.

const DEFAULT_STATE = {
  enabled: false,
  activeProfileId: null,
  profiles: []
};

const DEFAULT_SETTINGS = {
  theme: "light",
  routingRules: [],
  vault: {
    enabled: false,
    salt: null,
    check: null
  }
};

const DEFAULT_STATS = {
  since: Date.now(),
  rxBytes: 0,
  txBytes: 0
};

const DEFAULT_RUNTIME_STATUS = {
  code: "disabled",
  title: "Выключено",
  detail: "Прокси сейчас не используется.",
  level: "neutral",
  lastUpdated: Date.now(),
  lastError: null,
  test: {
    ok: false,
    ip: null,
    pingMs: null,
    checkedAt: null,
    message: null
  }
};

const VAULT_SESSION_KEY = "vaultSessionKey";
const VAULT_CHECK_PLAINTEXT = "proxy-switcher-vault-check-v1";
const PBKDF2_ITERATIONS = 250000;
const TEST_URLS = [
  "https://api64.ipify.org?format=json",
  "https://api.ipify.org?format=json",
  "https://1.1.1.1/cdn-cgi/trace"
];

const reqTxBytes = new Map();
let activeTestRun = null;

function now() {
  return Date.now();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseBypassList(raw) {
  if (!raw) return ["<local>"];
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : ["<local>"];
}

function findActiveProfile(state) {
  if (!state?.profiles?.length) return null;
  return state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0] || null;
}

function sanitizeProfile(profile) {
  if (!profile) return null;
  const { username, password, authSecret, ...rest } = profile;
  return {
    ...rest,
    hasCredentials: !!(username || password || authSecret),
    credentialsLocked: !!authSecret,
    usernamePresent: !!username,
    passwordPresent: !!password
  };
}

function sanitizeState(state) {
  return {
    ...state,
    profiles: Array.isArray(state?.profiles) ? state.profiles.map(sanitizeProfile) : []
  };
}

async function ensureStats() {
  const stored = await chrome.storage.local.get({ stats: null });
  if (!stored.stats) {
    await chrome.storage.local.set({ stats: { ...DEFAULT_STATS, since: now(), rxBytes: 0, txBytes: 0 } });
  }
}

async function ensureRuntimeStatus() {
  const stored = await chrome.storage.local.get({ runtimeStatus: null });
  if (!stored.runtimeStatus) {
    await chrome.storage.local.set({ runtimeStatus: { ...DEFAULT_RUNTIME_STATUS, lastUpdated: now() } });
  }
}

async function migrateIfNeeded() {
  const stored = await chrome.storage.local.get([
    "profiles", "activeProfileId", "enabled", "settings",
    "runtimeStatus", "stats",
    // legacy single-profile keys
    "scheme", "host", "port", "authRequired", "username", "password", "bypass"
  ]);

  const hasProfiles = Array.isArray(stored.profiles);
  const hasLegacy = stored.scheme || stored.host || stored.port || stored.username || stored.password;

  if (!hasProfiles && hasLegacy) {
    const id = crypto?.randomUUID?.() || ("p_" + Math.random().toString(16).slice(2) + now().toString(16));
    const profile = {
      id,
      name: "Imported",
      scheme: stored.scheme || "http",
      host: stored.host || "",
      port: Number(stored.port || 8080),
      authRequired: !!stored.authRequired,
      username: stored.username || "",
      password: stored.password || "",
      bypass: stored.bypass || "<local>"
    };
    await chrome.storage.local.set({
      profiles: [profile],
      activeProfileId: id,
      enabled: !!stored.enabled
    });
  }

  if (!stored.settings || typeof stored.settings !== "object") {
    await chrome.storage.local.set({ settings: clone(DEFAULT_SETTINGS) });
  } else {
    const normalized = {
      ...DEFAULT_SETTINGS,
      ...stored.settings,
      vault: { ...DEFAULT_SETTINGS.vault, ...(stored.settings.vault || {}) },
      routingRules: Array.isArray(stored.settings.routingRules) ? stored.settings.routingRules : []
    };
    await chrome.storage.local.set({ settings: normalized });
  }

  await ensureStats();
  await ensureRuntimeStatus();
}

async function getStateRaw() {
  await migrateIfNeeded();
  const stored = await chrome.storage.local.get(DEFAULT_STATE);
  const state = { ...DEFAULT_STATE, ...stored };
  if (!Array.isArray(state.profiles)) state.profiles = [];
  if (state.activeProfileId && !state.profiles.find((p) => p.id === state.activeProfileId)) {
    state.activeProfileId = state.profiles[0]?.id ?? null;
    await chrome.storage.local.set({ activeProfileId: state.activeProfileId });
  }
  return state;
}

async function getSettings() {
  await migrateIfNeeded();
  const stored = await chrome.storage.local.get({ settings: clone(DEFAULT_SETTINGS) });
  return {
    ...DEFAULT_SETTINGS,
    ...(stored.settings || {}),
    vault: { ...DEFAULT_SETTINGS.vault, ...((stored.settings || {}).vault || {}) },
    routingRules: Array.isArray((stored.settings || {}).routingRules) ? stored.settings.routingRules : []
  };
}

async function getRuntimeStatus() {
  await ensureRuntimeStatus();
  const stored = await chrome.storage.local.get({ runtimeStatus: clone(DEFAULT_RUNTIME_STATUS) });
  return { ...DEFAULT_RUNTIME_STATUS, ...(stored.runtimeStatus || {}) };
}

async function setRuntimeStatus(patch) {
  const current = await getRuntimeStatus();
  const next = {
    ...current,
    ...patch,
    lastUpdated: now(),
    test: { ...(current.test || DEFAULT_RUNTIME_STATUS.test), ...((patch && patch.test) || {}) }
  };
  await chrome.storage.local.set({ runtimeStatus: next });
  return next;
}

async function getStats() {
  await ensureStats();
  const stored = await chrome.storage.local.get({ stats: clone(DEFAULT_STATS) });
  const stats = stored.stats || clone(DEFAULT_STATS);
  if (!stats.since) stats.since = now();
  if (typeof stats.rxBytes !== "number") stats.rxBytes = 0;
  if (typeof stats.txBytes !== "number") stats.txBytes = 0;
  return stats;
}

async function addTraffic({ rx = 0, tx = 0 }) {
  try {
    const stats = await getStats();
    const next = {
      since: stats.since || now(),
      rxBytes: (stats.rxBytes || 0) + (rx || 0),
      txBytes: (stats.txBytes || 0) + (tx || 0)
    };
    await chrome.storage.local.set({ stats: next });
  } catch {
    // ignore
  }
}

function bufferToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveVaultKey(password, saltB64) {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: b64ToBytes(saltB64),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function importSessionVaultKey(rawB64) {
  if (!rawB64) return null;
  return crypto.subtle.importKey(
    "raw",
    b64ToBytes(rawB64),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function exportSessionVaultKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufferToB64(raw);
}

async function getSessionVaultKey() {
  const stored = await chrome.storage.session.get({ [VAULT_SESSION_KEY]: null });
  if (!stored[VAULT_SESSION_KEY]) return null;
  return importSessionVaultKey(stored[VAULT_SESSION_KEY]);
}

async function storeSessionVaultKey(key) {
  const rawB64 = await exportSessionVaultKey(key);
  await chrome.storage.session.set({ [VAULT_SESSION_KEY]: rawB64, vaultUnlockedAt: now() });
}

async function clearSessionVaultKey() {
  await chrome.storage.session.remove([VAULT_SESSION_KEY, "vaultUnlockedAt"]);
}

async function isVaultUnlocked(settings) {
  if (!settings?.vault?.enabled) return true;
  const stored = await chrome.storage.session.get({ [VAULT_SESSION_KEY]: null });
  return !!stored[VAULT_SESSION_KEY];
}

async function encryptPayload(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
  return {
    v: 1,
    iv: bufferToB64(iv),
    data: bufferToB64(encrypted)
  };
}

async function decryptPayload(secret, key) {
  const iv = b64ToBytes(secret.iv);
  const data = b64ToBytes(secret.data);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function verifyVaultPassword(password, settings) {
  if (!settings?.vault?.enabled || !settings.vault.salt || !settings.vault.check) {
    throw new Error("Хранилище не настроено.");
  }
  const key = await deriveVaultKey(password, settings.vault.salt);
  const probe = await decryptPayload(settings.vault.check, key);
  if (probe !== VAULT_CHECK_PLAINTEXT) throw new Error("Неверный пароль хранилища.");
  return key;
}

async function decryptProfileCredentials(profile, key) {
  if (!profile?.authSecret) {
    return {
      username: profile?.username || "",
      password: profile?.password || ""
    };
  }
  const payload = await decryptPayload(profile.authSecret, key);
  return {
    username: payload?.username || "",
    password: payload?.password || ""
  };
}

function withProfileCredentials(profile, creds) {
  return {
    ...profile,
    username: creds?.username || "",
    password: creds?.password || ""
  };
}

function humanizeError(raw) {
  const msg = String(raw || "").trim();
  const upper = msg.toUpperCase();
  if (!msg) {
    return {
      title: "Ошибка подключения",
      detail: "Не удалось проверить соединение через прокси."
    };
  }
  if (upper.includes("ERR_PROXY_CONNECTION_FAILED")) {
    return {
      title: "Прокси недоступен",
      detail: "Браузер не смог подключиться к прокси-серверу. Проверь адрес, порт и доступность сервера."
    };
  }
  if (upper.includes("ERR_TUNNEL_CONNECTION_FAILED")) {
    return {
      title: "Не удалось поднять туннель",
      detail: "Прокси ответил ошибкой при попытке открыть соединение."
    };
  }
  if (upper.includes("ERR_CONNECTION_TIMED_OUT") || upper.includes("TIMEOUT") || upper.includes("ABORT")) {
    return {
      title: "Таймаут",
      detail: "Прокси слишком долго отвечает. Возможно, сервер перегружен или недоступен."
    };
  }
  if (upper.includes("ERR_NAME_NOT_RESOLVED") || upper.includes("DNS")) {
    return {
      title: "Не найден хост",
      detail: "Браузер не смог разрешить адрес прокси или тестового сервиса."
    };
  }
  if (upper.includes("407") || upper.includes("AUTH") || upper.includes("CREDENTIAL")) {
    return {
      title: "Ошибка авторизации",
      detail: "Похоже, логин или пароль прокси не подошли."
    };
  }
  if (upper.includes("SOCKS")) {
    return {
      title: "Проблема с SOCKS",
      detail: "SOCKS-прокси ответил ошибкой. Для логина/пароля лучше использовать HTTP/HTTPS, потому что SOCKS5 auth в Chromium нестабилен."
    };
  }
  return {
    title: "Ошибка подключения",
    detail: msg
  };
}

function profileSummary(p) {
  const scheme = (p?.scheme || "http").toUpperCase();
  return `${scheme} · ${p?.host || "—"}:${p?.port || "—"}`;
}

function proxyPacToken(profile) {
  const host = profile.host;
  const port = Number(profile.port);
  switch ((profile.scheme || "http").toLowerCase()) {
    case "https":
      return `HTTPS ${host}:${port}`;
    case "socks4":
      return `SOCKS ${host}:${port}`;
    case "socks5":
      return `SOCKS5 ${host}:${port}`;
    case "http":
    default:
      return `PROXY ${host}:${port}`;
  }
}

function escapeJsString(value) {
  return JSON.stringify(String(value));
}

function ipv4MaskFromPrefix(prefix) {
  const p = Number(prefix);
  if (!Number.isInteger(p) || p < 0 || p > 32) return null;
  let mask = 0;
  if (p === 0) mask = 0;
  else mask = (~0 << (32 - p)) >>> 0;
  return [
    (mask >>> 24) & 255,
    (mask >>> 16) & 255,
    (mask >>> 8) & 255,
    mask & 255
  ].join(".");
}

function normalizeRule(rawRule) {
  if (!rawRule || typeof rawRule !== "object") return null;
  const rule = {
    id: rawRule.id || crypto?.randomUUID?.() || ("r_" + Math.random().toString(16).slice(2)),
    type: rawRule.type === "cidr" ? "cidr" : "host",
    action: rawRule.action === "direct" ? "direct" : "proxy",
    value: String(rawRule.value || "").trim()
  };
  return rule.value ? rule : null;
}

function buildPacCondition(rule) {
  const value = String(rule.value || "").trim();
  if (!value) return null;

  if (rule.type === "cidr") {
    const [base, prefix] = value.split("/");
    if (!base || prefix == null) return null;
    const mask = ipv4MaskFromPrefix(prefix);
    if (!mask) return null;
    return `isInNet(dnsResolve(host), ${escapeJsString(base.trim())}, ${escapeJsString(mask)})`;
  }

  if (value === "<local>") return "isPlainHostName(host)";

  if (/^\d+\.\d+\.\d+\.\d+(?:\/\d+)?$/.test(value)) {
    if (value.includes("/")) {
      const [base, prefix] = value.split("/");
      const mask = ipv4MaskFromPrefix(prefix);
      if (!mask) return null;
      return `isInNet(host, ${escapeJsString(base)}, ${escapeJsString(mask)})`;
    }
    return `host === ${escapeJsString(value)}`;
  }

  const noScheme = value.replace(/^[a-z]+:\/\//i, "").replace(/:\d+$/, "").trim();
  if (!noScheme) return null;
  if (noScheme.startsWith("*.")) {
    return `dnsDomainIs(host, ${escapeJsString(noScheme.slice(1))})`;
  }
  if (noScheme.startsWith(".")) {
    return `dnsDomainIs(host, ${escapeJsString(noScheme)})`;
  }
  if (noScheme.includes("*")) {
    return `shExpMatch(host, ${escapeJsString(noScheme)})`;
  }
  return `host === ${escapeJsString(noScheme)}`;
}

function buildPacScript(profile, routingRules, bypassList) {
  const proxyToken = proxyPacToken(profile);
  const customRules = Array.isArray(routingRules)
    ? routingRules.map(normalizeRule).filter(Boolean)
    : [];
  const bypassRules = Array.isArray(bypassList)
    ? bypassList.map((value) => normalizeRule({ type: /^\d+\.\d+\.\d+\.\d+(?:\/\d+)?$/.test(value.trim()) ? "cidr" : "host", action: "direct", value })).filter(Boolean)
    : [];

  const checks = [];

  for (const rule of [...bypassRules, ...customRules]) {
    const condition = buildPacCondition(rule);
    if (!condition) continue;
    checks.push(`  if (${condition}) return ${escapeJsString(rule.action === "direct" ? "DIRECT" : proxyToken)};`);
  }

  return [
    "function FindProxyForURL(url, host) {",
    ...checks,
    `  return ${escapeJsString(proxyToken)};`,
    "}"
  ].join("\n");
}

function validateProfile(profile) {
  if (!profile?.name) return "Укажи название профиля.";
  if (!profile?.host) return "Укажи адрес или IP прокси.";
  const port = Number(profile.port);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return "Порт должен быть числом от 1 до 65535.";
  }
  if (profile.scheme === "socks5" && profile.authRequired) {
    return "SOCKS5 с логином и паролем в Chromium работает нестабильно. Лучше использовать HTTP/HTTPS, либо SOCKS5 без авторизации.";
  }
  if (profile.authRequired && (!profile.username || !profile.password)) {
    return "Для прокси с авторизацией нужно заполнить логин и пароль.";
  }
  return null;
}

async function applyFromStorage(reason = "state") {
  const state = await getStateRaw();
  const settings = await getSettings();
  const active = findActiveProfile(state);
  const vaultUnlocked = await isVaultUnlocked(settings);

  if (!state.enabled) {
    await chrome.proxy.settings.set({ value: { mode: "direct" }, scope: "regular" });
    await setRuntimeStatus({
      code: "disabled",
      title: "Выключено",
      detail: "Прокси сейчас не используется.",
      level: "neutral",
      lastError: null,
      test: { ok: false, ip: null, pingMs: null, checkedAt: null, message: null }
    });
    return;
  }

  if (!active?.host) {
    await chrome.proxy.settings.set({ value: { mode: "direct" }, scope: "regular" });
    await setRuntimeStatus({
      code: "missing_profile",
      title: "Нет активного профиля",
      detail: "Выбери или создай профиль прокси перед включением.",
      level: "warning",
      lastError: null,
      test: { ok: false, ip: null, pingMs: null, checkedAt: now(), message: "Нет профиля" }
    });
    return;
  }

  if (active.authRequired && settings.vault.enabled && !vaultUnlocked) {
    await chrome.proxy.settings.set({ value: { mode: "direct" }, scope: "regular" });
    await setRuntimeStatus({
      code: "vault_locked",
      title: "Хранилище заблокировано",
      detail: `Разблокируй хранилище, чтобы использовать профиль ${active.name || profileSummary(active)}.`,
      level: "warning",
      lastError: null,
      test: { ok: false, ip: null, pingMs: null, checkedAt: now(), message: "Нужен пароль хранилища" }
    });
    return;
  }

  const bypassList = parseBypassList(active.bypass);
  const routingRules = Array.isArray(settings.routingRules) ? settings.routingRules : [];

  if (routingRules.length > 0) {
    const pacScript = buildPacScript(active, routingRules, bypassList);
    await chrome.proxy.settings.set({
      value: {
        mode: "pac_script",
        pacScript: {
          data: pacScript,
          mandatory: true
        }
      },
      scope: "regular"
    });
  } else {
    await chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: {
            scheme: active.scheme || "http",
            host: active.host,
            port: Number(active.port)
          },
          bypassList
        }
      },
      scope: "regular"
    });
  }

  await setRuntimeStatus({
    code: reason === "test" ? "testing" : "enabled",
    title: reason === "test" ? "Проверяем соединение" : "Прокси включён",
    detail: routingRules.length
      ? `Активен ${profileSummary(active)} · включены правила маршрутизации`
      : `Активен ${profileSummary(active)}`,
    level: reason === "test" ? "info" : "success",
    lastError: null
  });
}

async function testConnectivity() {
  if (activeTestRun) return activeTestRun;

  activeTestRun = (async () => {
    const state = await getStateRaw();
    const settings = await getSettings();
    const active = findActiveProfile(state);

    if (!state.enabled || !active?.host) {
      const status = await setRuntimeStatus({
        code: "disabled",
        title: "Выключено",
        detail: "Сначала включи прокси и выбери профиль.",
        level: "neutral",
        test: { ok: false, ip: null, pingMs: null, checkedAt: now(), message: "Прокси выключен" }
      });
      return { ok: false, status };
    }

    if (active.authRequired && settings.vault.enabled && !(await isVaultUnlocked(settings))) {
      const status = await setRuntimeStatus({
        code: "vault_locked",
        title: "Хранилище заблокировано",
        detail: "Разблокируй хранилище, чтобы пройти проверку подключения.",
        level: "warning",
        test: { ok: false, ip: null, pingMs: null, checkedAt: now(), message: "Нужен пароль хранилища" }
      });
      return { ok: false, status };
    }

    await setRuntimeStatus({
      code: "testing",
      title: "Проверяем соединение",
      detail: `Тестируем ${profileSummary(active)}`,
      level: "info",
      lastError: null,
      test: { ok: false, ip: null, pingMs: null, checkedAt: now(), message: "Идёт проверка" }
    });

    for (const url of TEST_URLS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const startedAt = performance.now();
      try {
        const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`, {
          cache: "no-store",
          signal: controller.signal
        });
        const pingMs = Math.round(performance.now() - startedAt);
        clearTimeout(timer);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        let ip = null;
        if (url.includes("ipify")) {
          const json = await res.json();
          ip = json?.ip || null;
        } else {
          const text = await res.text();
          const match = text.match(/^ip=([^\n]+)$/m);
          ip = match?.[1]?.trim() || null;
        }

        const status = await setRuntimeStatus({
          code: "connected",
          title: "Подключено",
          detail: `${profileSummary(active)}${ip ? ` · внешний IP ${ip}` : ""}`,
          level: "success",
          lastError: null,
          test: { ok: true, ip, pingMs, checkedAt: now(), message: "Соединение работает" }
        });
        return { ok: true, ip, pingMs, status };
      } catch (error) {
        clearTimeout(timer);
        const human = humanizeError(error?.message || error);
        await setRuntimeStatus({
          code: "error",
          title: human.title,
          detail: human.detail,
          level: "danger",
          lastError: String(error?.message || error),
          test: { ok: false, ip: null, pingMs: null, checkedAt: now(), message: human.detail }
        });
      }
    }

    const status = await getRuntimeStatus();
    return { ok: false, status };
  })();

  try {
    return await activeTestRun;
  } finally {
    activeTestRun = null;
  }
}

function scheduleConnectivityTest() {
  setTimeout(() => {
    testConnectivity().catch(() => {});
  }, 250);
}

async function getBootstrap() {
  const [state, settings, runtimeStatus, session, stats] = await Promise.all([
    getStateRaw(),
    getSettings(),
    getRuntimeStatus(),
    chrome.storage.session.get({ [VAULT_SESSION_KEY]: null, vaultUnlockedAt: null }),
    getStats()
  ]);

  return {
    state: sanitizeState(state),
    settings,
    runtimeStatus,
    stats,
    vault: {
      enabled: !!settings.vault.enabled,
      unlocked: !!session[VAULT_SESSION_KEY],
      unlockedAt: session.vaultUnlockedAt || null
    }
  };
}

async function getProfileForEditor(id) {
  const state = await getStateRaw();
  const settings = await getSettings();
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("Профиль не найден.");

  let username = profile.username || "";
  let password = profile.password || "";
  let credentialsLocked = false;

  if (profile.authSecret) {
    const key = await getSessionVaultKey();
    if (key) {
      const creds = await decryptProfileCredentials(profile, key);
      username = creds.username;
      password = creds.password;
    } else {
      credentialsLocked = !!settings.vault.enabled;
      username = "";
      password = "";
    }
  }

  return {
    profile: {
      ...sanitizeProfile(profile),
      username,
      password
    },
    credentialsLocked
  };
}

async function saveProfile(profileInput) {
  const state = await getStateRaw();
  const settings = await getSettings();
  const profiles = Array.isArray(state.profiles) ? [...state.profiles] : [];
  const existingIndex = profileInput.id ? profiles.findIndex((p) => p.id === profileInput.id) : -1;
  const current = existingIndex >= 0 ? profiles[existingIndex] : null;

  const profile = {
    id: profileInput.id || crypto?.randomUUID?.() || ("p_" + Math.random().toString(16).slice(2) + now().toString(16)),
    name: String(profileInput.name || "").trim(),
    scheme: String(profileInput.scheme || "http").toLowerCase(),
    host: String(profileInput.host || "").trim(),
    port: Number(profileInput.port || 0),
    authRequired: !!profileInput.authRequired,
    bypass: String(profileInput.bypass || "<local>").trim() || "<local>",
    username: String(profileInput.username || "").trim(),
    password: String(profileInput.password || "")
  };

  const validationError = validateProfile(profile);
  if (validationError) throw new Error(validationError);

  let nextProfile = {
    ...current,
    ...profile
  };

  if (!profile.authRequired) {
    delete nextProfile.authSecret;
    nextProfile.username = "";
    nextProfile.password = "";
  } else if (settings.vault.enabled) {
    const key = await getSessionVaultKey();
    if (!key) {
      throw new Error("Разблокируй хранилище, чтобы сохранить логин и пароль прокси.");
    }
    nextProfile.authSecret = await encryptPayload({ username: profile.username, password: profile.password }, key);
    nextProfile.username = "";
    nextProfile.password = "";
  }

  if (existingIndex >= 0) profiles[existingIndex] = nextProfile;
  else profiles.push(nextProfile);

  const activeProfileId = profile.id;
  await chrome.storage.local.set({ profiles, activeProfileId });
  await applyFromStorage("save");
  return getBootstrap();
}

async function deleteProfile(id) {
  const state = await getStateRaw();
  const profiles = (state.profiles || []).filter((p) => p.id !== id);
  const activeProfileId = state.activeProfileId === id ? (profiles[0]?.id || null) : state.activeProfileId;
  await chrome.storage.local.set({ profiles, activeProfileId });
  await applyFromStorage("delete");
  return getBootstrap();
}

async function patchState(patch) {
  const allowed = {};
  if (typeof patch.enabled === "boolean") allowed.enabled = patch.enabled;
  if (typeof patch.activeProfileId === "string" || patch.activeProfileId === null) allowed.activeProfileId = patch.activeProfileId;
  await chrome.storage.local.set(allowed);
  await applyFromStorage("state");
  if (allowed.enabled) scheduleConnectivityTest();
  return getBootstrap();
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...(patch || {}),
    vault: { ...current.vault, ...((patch || {}).vault || {}) },
    routingRules: Array.isArray((patch || {}).routingRules) ? patch.routingRules.map(normalizeRule).filter(Boolean) : current.routingRules
  };
  await chrome.storage.local.set({ settings: next });
  await applyFromStorage("settings");
  return getBootstrap();
}

async function enableVault(password) {
  if (!password || password.length < 6) {
    throw new Error("Пароль хранилища должен быть не короче 6 символов.");
  }

  const settings = await getSettings();
  if (settings.vault.enabled) throw new Error("Хранилище уже включено.");

  const salt = bufferToB64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveVaultKey(password, salt);
  const check = await encryptPayload(VAULT_CHECK_PLAINTEXT, key);
  const state = await getStateRaw();
  const profiles = [];

  for (const profile of state.profiles || []) {
    const next = { ...profile };
    if (profile.authRequired && (profile.username || profile.password)) {
      next.authSecret = await encryptPayload({ username: profile.username || "", password: profile.password || "" }, key);
      next.username = "";
      next.password = "";
    }
    profiles.push(next);
  }

  await chrome.storage.local.set({
    profiles,
    settings: {
      ...settings,
      vault: {
        enabled: true,
        salt,
        check
      }
    }
  });
  await storeSessionVaultKey(key);
  await applyFromStorage("vault");
  return getBootstrap();
}

async function unlockVault(password) {
  const settings = await getSettings();
  const key = await verifyVaultPassword(password, settings);
  await storeSessionVaultKey(key);
  await applyFromStorage("vault");
  scheduleConnectivityTest();
  return getBootstrap();
}

async function lockVault() {
  await clearSessionVaultKey();
  await applyFromStorage("vault");
  return getBootstrap();
}

async function disableVault(password) {
  const settings = await getSettings();
  if (!settings.vault.enabled) return getBootstrap();
  let key = await getSessionVaultKey();
  if (!key) {
    if (!password) throw new Error("Нужен пароль хранилища, чтобы отключить защиту.");
    key = await verifyVaultPassword(password, settings);
  }

  const state = await getStateRaw();
  const profiles = [];
  for (const profile of state.profiles || []) {
    const next = { ...profile };
    if (profile.authSecret) {
      const creds = await decryptProfileCredentials(profile, key);
      next.username = creds.username;
      next.password = creds.password;
      delete next.authSecret;
    }
    profiles.push(next);
  }

  await chrome.storage.local.set({
    profiles,
    settings: {
      ...settings,
      vault: {
        enabled: false,
        salt: null,
        check: null
      }
    }
  });
  await clearSessionVaultKey();
  await applyFromStorage("vault");
  return getBootstrap();
}

async function exportData() {
  const [state, settings] = await Promise.all([getStateRaw(), getSettings()]);
  return {
    app: "chasy.net extension",
    version: 2,
    exportedAt: new Date().toISOString(),
    state: clone(state),
    settings: clone(settings)
  };
}

async function importData(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Файл импорта пустой или повреждён.");
  const state = payload.state || {};
  const settings = payload.settings || {};
  const profiles = Array.isArray(state.profiles) ? state.profiles.map((p) => ({ ...p })) : [];
  const activeProfileId = state.activeProfileId && profiles.find((p) => p.id === state.activeProfileId)
    ? state.activeProfileId
    : (profiles[0]?.id || null);

  await chrome.storage.local.set({
    enabled: !!state.enabled,
    activeProfileId,
    profiles,
    settings: {
      ...DEFAULT_SETTINGS,
      ...settings,
      vault: { ...DEFAULT_SETTINGS.vault, ...(settings.vault || {}) },
      routingRules: Array.isArray(settings.routingRules) ? settings.routingRules.map(normalizeRule).filter(Boolean) : []
    }
  });

  await clearSessionVaultKey();
  await applyFromStorage("import");
  if (state.enabled) scheduleConnectivityTest();
  return getBootstrap();
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getStateRaw();
  await applyFromStorage("install");
  if (state.enabled) scheduleConnectivityTest();
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getStateRaw();
  await applyFromStorage("startup");
  if (state.enabled) scheduleConnectivityTest();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  const relevant = ["enabled", "activeProfileId", "profiles", "settings"];
  if (!relevant.some((key) => key in changes)) return;
  // apply is already called by our own write paths, but this helps after manual edits/imports.
  await applyFromStorage("storage");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "GET_BOOTSTRAP":
        sendResponse({ ok: true, ...(await getBootstrap()) });
        return;
      case "PATCH_STATE":
        sendResponse({ ok: true, ...(await patchState(msg.patch || {})) });
        return;
      case "SAVE_SETTINGS":
        sendResponse({ ok: true, ...(await saveSettings(msg.patch || {})) });
        return;
      case "GET_PROFILE":
        sendResponse({ ok: true, ...(await getProfileForEditor(msg.id)) });
        return;
      case "UPSERT_PROFILE":
        sendResponse({ ok: true, ...(await saveProfile(msg.profile || {})) });
        return;
      case "DELETE_PROFILE":
        sendResponse({ ok: true, ...(await deleteProfile(msg.id)) });
        return;
      case "GET_STATS":
        sendResponse({ ok: true, stats: await getStats() });
        return;
      case "RESET_STATS":
        await chrome.storage.local.set({ stats: { ...DEFAULT_STATS, since: now(), rxBytes: 0, txBytes: 0 } });
        sendResponse({ ok: true, stats: await getStats() });
        return;
      case "GET_RUNTIME_STATUS":
        sendResponse({ ok: true, runtimeStatus: await getRuntimeStatus() });
        return;
      case "RUN_TEST":
        sendResponse({ ok: true, ...(await testConnectivity()) });
        return;
      case "EXPORT_DATA":
        sendResponse({ ok: true, data: await exportData() });
        return;
      case "IMPORT_DATA":
        sendResponse({ ok: true, ...(await importData(msg.data)) });
        return;
      case "ENABLE_VAULT":
        sendResponse({ ok: true, ...(await enableVault(String(msg.password || ""))) });
        return;
      case "UNLOCK_VAULT":
        sendResponse({ ok: true, ...(await unlockVault(String(msg.password || ""))) });
        return;
      case "LOCK_VAULT":
        sendResponse({ ok: true, ...(await lockVault()) });
        return;
      case "DISABLE_VAULT":
        sendResponse({ ok: true, ...(await disableVault(String(msg.password || ""))) });
        return;
      default:
        sendResponse({ ok: false, error: "Неизвестная команда." });
    }
  })().catch(async (error) => {
    const human = humanizeError(error?.message || error);
    if (msg?.type !== "GET_BOOTSTRAP") {
      await setRuntimeStatus({
        code: "error",
        title: human.title,
        detail: human.detail,
        level: "danger",
        lastError: String(error?.message || error)
      }).catch(() => {});
    }
    sendResponse({ ok: false, error: String(error?.message || error), title: human.title, detail: human.detail });
  });
  return true;
});

chrome.proxy.onProxyError.addListener(async (details) => {
  const human = humanizeError(details?.error || details?.details || "Ошибка proxy API");
  await setRuntimeStatus({
    code: "error",
    title: human.title,
    detail: human.detail,
    level: details?.fatal ? "danger" : "warning",
    lastError: details?.error || details?.details || null,
    test: {
      ok: false,
      ip: null,
      pingMs: null,
      checkedAt: now(),
      message: human.detail
    }
  });
});

function getHeaderValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const lower = name.toLowerCase();
  const h = headers.find((x) => (x.name || "").toLowerCase() === lower);
  return h?.value ?? null;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const v = getHeaderValue(details.requestHeaders, "content-length");
      const n = v ? Number(v) : 0;
      if (Number.isFinite(n) && n > 0) reqTxBytes.set(details.requestId, n);
    } catch {}
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    try {
      const v = getHeaderValue(details.responseHeaders, "content-length");
      const n = v ? Number(v) : 0;
      if (Number.isFinite(n) && n > 0) addTraffic({ rx: n, tx: 0 });
    } catch {}
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    try {
      const tx = reqTxBytes.get(details.requestId) || 0;
      if (tx) addTraffic({ rx: 0, tx });
    } catch {}
    reqTxBytes.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => reqTxBytes.delete(details.requestId),
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onAuthRequired.addListener(
  async (details, callback) => {
    try {
      if (!details.isProxy) return callback({});
      const [state, settings] = await Promise.all([getStateRaw(), getSettings()]);
      if (!state.enabled) return callback({});

      const profile = findActiveProfile(state);
      if (!profile?.authRequired) return callback({});

      const challenger = details.challenger || {};
      if (profile.host && challenger.host && challenger.host !== profile.host) return callback({});
      if (profile.port && challenger.port && Number(challenger.port) !== Number(profile.port)) return callback({});

      let creds = { username: profile.username || "", password: profile.password || "" };
      if (profile.authSecret) {
        const key = await getSessionVaultKey();
        if (!key) {
          await setRuntimeStatus({
            code: "vault_locked",
            title: "Хранилище заблокировано",
            detail: "Браузеру нужен пароль от хранилища, чтобы отдать логин и пароль прокси.",
            level: "warning",
            test: { ok: false, ip: null, pingMs: null, checkedAt: now(), message: "Нужен пароль хранилища" }
          });
          return callback({});
        }
        creds = await decryptProfileCredentials(profile, key);
      }

      callback({ authCredentials: { username: creds.username || "", password: creds.password || "" } });
    } catch {
      callback({});
    }
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
