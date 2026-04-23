const $ = (id) => document.getElementById(id);

let boot = null;
let view = "profiles";
let editingId = null;
let editorCredentialsLocked = false;
let statusTimer = null;

function send(type, payload = {}) {
  const maybe = chrome.runtime.sendMessage({ type, ...payload });
  if (maybe && typeof maybe.then === "function") return maybe;
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, ...payload }, (resp) => resolve(resp)));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtBytes(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : x < 10 ? 1 : 0;
  return `${x.toFixed(digits)} ${units[i]}`;
}

function fmtWhen(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtSince(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  const h = Math.floor(mins / 60);
  return `${h} ч назад`;
}

function profileSummary(p) {
  const scheme = (p?.scheme || "http").toUpperCase();
  return `${scheme} · ${p?.host || "—"}:${p?.port || "—"}`;
}

function activeProfile() {
  return boot?.state?.profiles?.find((p) => p.id === boot?.state?.activeProfileId) || boot?.state?.profiles?.[0] || null;
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === "dark" ? "dark" : "light";
  $("themeLight").classList.toggle("active", theme === "light");
  $("themeDark").classList.toggle("active", theme === "dark");
  $("themeToggle").textContent = theme === "dark" ? "☀" : "☾";
}

function nextTheme() {
  return boot?.settings?.theme === "dark" ? "light" : "dark";
}

function setSubtitle(text) {
  $("subtitle").textContent = text || "";
}

function setNotice(text = "", kind = "") {
  const el = $("notice");
  if (!text) {
    el.hidden = true;
    el.className = "notice";
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.className = `notice ${kind}`.trim();
  el.textContent = text;
}

function setGlobalNotice(text = "", kind = "") {
  const el = $("globalNotice");
  if (!text) {
    el.hidden = true;
    el.className = "notice";
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.className = `notice ${kind}`.trim();
  el.textContent = text;
}

function showAuthBlock(on) {
  $("authBlock").style.display = on ? "grid" : "none";
}

function setTab(tab) {
  $("tabProfiles").classList.toggle("active", tab === "profiles");
  $("tabStats").classList.toggle("active", tab === "stats");
  $("tabSettings").classList.toggle("active", tab === "settings");
}

function showView(name) {
  view = name;
  $("viewProfiles").hidden = name !== "profiles";
  $("viewEditor").hidden = name !== "editor";
  $("viewStats").hidden = name !== "stats";
  $("viewSettings").hidden = name !== "settings";
  $("backBtn").hidden = name !== "editor";
  $("fabAdd").hidden = name !== "profiles" || !(boot?.state?.profiles?.length > 0);

  if (name === "profiles") {
    setTab("profiles");
    setSubtitle("Главная");
    startStatusPolling();
  } else if (name === "stats") {
    setTab("stats");
    setSubtitle("Статус и трафик");
    startStatusPolling();
  } else if (name === "settings") {
    setTab("settings");
    setSubtitle("Настройки");
    startStatusPolling();
  } else {
    setSubtitle(editingId ? "Редактирование" : "Новый профиль");
    stopStatusPolling();
  }
}

function renderStatusPanel() {
  const status = boot?.runtimeStatus || {};
  const badge = $("statusBadge");
  badge.className = `statusBadge topStatus ${status.level || "neutral"}`;
  badge.textContent = status.title || "—";
  badge.title = status.detail || status.title || "";
  $("enabled").checked = !!boot?.state?.enabled;
}

function renderProfilesList() {
  const list = $("profilesList");
  list.innerHTML = "";

  const profiles = Array.isArray(boot?.state?.profiles) ? boot.state.profiles : [];
  const empty = profiles.length === 0;
  $("emptyState").hidden = !empty;
  $("fabAdd").hidden = empty || view !== "profiles";
  if (empty) return;

  for (const p of profiles) {
    const card = document.createElement("div");
    card.className = "card" + (p.id === boot.state.activeProfileId ? " active" : "");

    const main = document.createElement("div");
    main.className = "cardMain";
    main.addEventListener("click", async () => {
      await patchState({ activeProfileId: p.id });
    });

    const titleRow = document.createElement("div");
    titleRow.className = "cardTitleRow";
    const title = document.createElement("div");
    title.className = "cardTitle";
    title.textContent = p.name || "Без названия";
    titleRow.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "cardMeta";
    meta.textContent = profileSummary(p);

    const badges = document.createElement("div");
    badges.className = "cardBadges";

    const primaryBadge = document.createElement("div");
    primaryBadge.className = `cardBadge ${p.id === boot.state.activeProfileId ? "success" : ""}`.trim();
    primaryBadge.textContent = p.id === boot.state.activeProfileId ? "Активный" : "Выбран";
    badges.appendChild(primaryBadge);

    if (p.authRequired) {
      const authBadge = document.createElement("div");
      authBadge.className = `cardBadge ${p.credentialsLocked ? "warning" : ""}`.trim();
      authBadge.textContent = p.credentialsLocked ? "Логин зашифрован" : "С авторизацией";
      badges.appendChild(authBadge);
    }

    if ((p.bypass || "").trim()) {
      const bypassBadge = document.createElement("div");
      bypassBadge.className = "cardBadge";
      bypassBadge.textContent = "Исключения";
      badges.appendChild(bypassBadge);
    }

    main.appendChild(titleRow);
    main.appendChild(meta);
    main.appendChild(badges);

    const actions = document.createElement("div");
    actions.className = "cardActions";

    const edit = document.createElement("button");
    edit.className = "smallBtn";
    edit.type = "button";
    edit.title = "Редактировать";
    edit.textContent = "✎";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditor(p.id);
    });

    const del = document.createElement("button");
    del.className = "smallBtn danger";
    del.type = "button";
    del.title = "Удалить";
    del.textContent = "−";
    del.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`Удалить профиль “${p.name || "Без названия"}”?`)) return;
      const res = await send("DELETE_PROFILE", { id: p.id });
      await applyResponse(res);
    });

    actions.appendChild(edit);
    actions.appendChild(del);
    card.appendChild(main);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function fillEditor(profile, locked) {
  $("profileName").value = profile?.name || "";
  $("scheme").value = profile?.scheme || "http";
  $("host").value = profile?.host || "";
  $("port").value = profile?.port || 8080;
  $("authRequired").checked = !!profile?.authRequired;
  $("username").value = profile?.username || "";
  $("password").value = profile?.password || "";
  $("bypass").value = (profile?.bypass || "<local>").trim() || "<local>";
  editorCredentialsLocked = !!locked;
  $("vaultHint").hidden = !locked;
  $("username").disabled = locked;
  $("password").disabled = locked;
  showAuthBlock(!!profile?.authRequired);
}

function readEditor() {
  return {
    id: editingId,
    name: $("profileName").value.trim(),
    scheme: $("scheme").value,
    host: $("host").value.trim(),
    port: Number($("port").value || 0),
    authRequired: $("authRequired").checked,
    username: $("username").value.trim(),
    password: $("password").value,
    bypass: $("bypass").value.trim()
  };
}

function validateProfile(profile) {
  if (!profile.name) return "Нужно дать профилю название.";
  if (!profile.host) return "Укажи адрес или IP прокси.";
  if (!Number.isFinite(profile.port) || profile.port < 1 || profile.port > 65535) return "Порт должен быть числом от 1 до 65535.";
  if (profile.scheme === "socks5" && profile.authRequired) return "SOCKS5 с логином и паролем в Chromium часто работает нестабильно. Лучше HTTP/HTTPS или SOCKS5 без авторизации.";
  if (profile.authRequired && editorCredentialsLocked) return "Сначала разблокируй хранилище, чтобы изменить логин и пароль.";
  if (profile.authRequired && (!profile.username || !profile.password)) return "Для прокси с авторизацией нужно указать логин и пароль.";
  return null;
}

async function openEditor(id = null) {
  editingId = id;
  setNotice();
  setGlobalNotice();
  if (!id) {
    fillEditor(null, false);
    showView("editor");
    return;
  }

  const res = await send("GET_PROFILE", { id });
  if (!res?.ok) return showError(res);
  fillEditor(res.profile, res.credentialsLocked);
  showView("editor");
}

function renderStats() {
  const stats = boot?.stats || {};
  const status = boot?.runtimeStatus || {};
  const test = status.test || {};
  $("statIp").textContent = test.ip || "—";
  $("statPing").textContent = test.pingMs ? `${test.pingMs} ms` : "—";
  $("statCheckedAt").textContent = test.checkedAt ? `Проверка: ${fmtWhen(test.checkedAt)}` : "Ещё не проверяли";
  $("statRx").textContent = fmtBytes(stats.rxBytes);
  $("statTx").textContent = fmtBytes(stats.txBytes);
  $("statSince").textContent = `Счётчики: ${fmtSince(stats.since)}`;
}

function renderVaultBox() {
  const enabled = !!boot?.vault?.enabled;
  const unlocked = !!boot?.vault?.unlocked;
  $("vaultState").textContent = !enabled ? "Выключена" : unlocked ? "Разблокирована" : "Заблокирована";
  $("vaultEnableBox").hidden = enabled;
  $("vaultUnlockBox").hidden = !enabled || unlocked;
  $("vaultManageBox").hidden = !enabled || !unlocked;
}

function renderRoutes() {
  const list = $("routesList");
  list.innerHTML = "";
  const rules = Array.isArray(boot?.settings?.routingRules) ? boot.settings.routingRules : [];
  if (!rules.length) {
    const hint = document.createElement("div");
    hint.className = "inlineHint";
    hint.textContent = "Правил пока нет. По умолчанию весь трафик идёт через активный профиль, кроме исключений из самого профиля.";
    list.appendChild(hint);
    return;
  }

  for (const rule of rules) {
    const item = document.createElement("div");
    item.className = "routeItem";

    const meta = document.createElement("div");
    meta.className = "routeMeta";
    meta.innerHTML = `
      <div class="routeTitle">${escapeHtml(rule.value)}</div>
      <div class="routeSub">${rule.type === "cidr" ? "IP / CIDR" : "Сайт / домен"} · ${rule.action === "direct" ? "Без прокси" : "Через прокси"}</div>
    `;

    const btn = document.createElement("button");
    btn.className = "smallBtn danger";
    btn.type = "button";
    btn.textContent = "−";
    btn.title = "Удалить правило";
    btn.addEventListener("click", async () => {
      const routingRules = rules.filter((x) => x.id !== rule.id);
      const res = await send("SAVE_SETTINGS", { patch: { routingRules } });
      await applyResponse(res);
      renderRoutes();
    });

    item.appendChild(meta);
    item.appendChild(btn);
    list.appendChild(item);
  }
}

function renderSettings() {
  applyTheme(boot?.settings?.theme || "light");
  renderVaultBox();
  renderRoutes();
}

async function refreshBootstrap() {
  const res = await send("GET_BOOTSTRAP");
  if (!res?.ok) throw new Error(res?.error || "Не удалось загрузить данные");
  boot = res;
  renderAll();
}

function renderAll() {
  renderStatusPanel();
  renderProfilesList();
  renderStats();
  renderSettings();

  if (view === "profiles") setSubtitle("Главная");
}

function showError(res) {
  const message = res?.detail || res?.error || "Что-то пошло не так.";
  if (view === "editor") setNotice(message, "error");
  else setGlobalNotice(message, "error");
}

async function applyResponse(res) {
  if (!res?.ok) {
    showError(res);
    throw new Error(res?.error || "Ошибка");
  }
  boot = res;
  renderAll();
  return res;
}

async function patchState(patch) {
  const res = await send("PATCH_STATE", { patch });
  return applyResponse(res);
}

async function saveTheme(theme) {
  const res = await send("SAVE_SETTINGS", { patch: { theme } });
  await applyResponse(res);
}

async function pollRuntime() {
  const [statusRes, statsRes] = await Promise.all([
    send("GET_RUNTIME_STATUS"),
    send("GET_STATS")
  ]);
  if (statusRes?.ok) boot.runtimeStatus = statusRes.runtimeStatus;
  if (statsRes?.ok) boot.stats = statsRes.stats;
  renderStatusPanel();
  renderStats();
}

function startStatusPolling() {
  stopStatusPolling();
  pollRuntime().catch(() => {});
  statusTimer = setInterval(() => {
    pollRuntime().catch(() => {});
  }, 1600);
}

function stopStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
}

async function runTest() {
  $("runTest").disabled = true;
  $("runTest").textContent = "Проверяем…";
  try {
    const res = await send("RUN_TEST");
    if (!res?.ok) showError(res);
    if (res?.ok && res.status) boot.runtimeStatus = res.status;
    const statsRes = await send("GET_STATS");
    if (statsRes?.ok) boot.stats = statsRes.stats;
    renderStatusPanel();
    renderStats();
  } finally {
    $("runTest").disabled = false;
    $("runTest").textContent = "Проверить";
  }
}

async function exportProfiles() {
  const res = await send("EXPORT_DATA");
  if (!res?.ok) return showError(res);
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chasy-net-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importProfiles(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await send("IMPORT_DATA", { data });
    await applyResponse(res);
    setGlobalNotice("Импорт завершён.", "success");
  } catch (error) {
    setGlobalNotice(error?.message || "Не удалось импортировать файл.", "error");
  }
}

async function handleEnableToggle() {
  const on = $("enabled").checked;
  const profile = activeProfile();
  if (on && profile?.authRequired && boot?.vault?.enabled && !boot?.vault?.unlocked) {
    $("enabled").checked = false;
    showView("settings");
    setGlobalNotice("Сначала разблокируй хранилище, чтобы включить прокси с авторизацией.", "error");
    return;
  }
  await patchState({ enabled: on });
  if (on) runTest().catch(() => {});
}

function routeFormValue() {
  return {
    id: crypto?.randomUUID?.() || `r_${Math.random().toString(16).slice(2)}`,
    value: $("routeValue").value.trim(),
    type: $("routeType").value,
    action: $("routeAction").value
  };
}

function validateRoute(rule) {
  if (!rule.value) return "Нужно указать домен или диапазон IP.";
  if (rule.type === "cidr" && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(rule.value)) return "Для IP-правила используй формат вроде 10.0.0.0/24.";
  return null;
}

async function init() {
  await refreshBootstrap();
  showView("profiles");

  $("tabProfiles").addEventListener("click", () => showView("profiles"));
  $("tabStats").addEventListener("click", () => showView("stats"));
  $("tabSettings").addEventListener("click", () => showView("settings"));
  $("backBtn").addEventListener("click", () => showView("profiles"));
  $("fabAdd").addEventListener("click", () => openEditor());
  $("addFirst").addEventListener("click", () => openEditor());
  $("authRequired").addEventListener("change", (e) => showAuthBlock(e.target.checked));
  $("cancelEdit").addEventListener("click", () => showView("profiles"));
  $("runTest").addEventListener("click", () => runTest().catch((e) => setGlobalNotice(e?.message || "Ошибка проверки.", "error")));
  $("enabled").addEventListener("change", () => handleEnableToggle().catch((e) => setGlobalNotice(e.message || "Ошибка", "error")));

  $("saveProfile").addEventListener("click", async () => {
    const profile = readEditor();
    const error = validateProfile(profile);
    if (error) return setNotice(error, "error");
    const res = await send("UPSERT_PROFILE", { profile });
    if (!res?.ok) return showError(res);
    await applyResponse(res);
    setNotice();
    showView("profiles");
  });

  document.addEventListener("keydown", async (event) => {
    if (view !== "editor") return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      $("saveProfile").click();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      showView("profiles");
    }
  });

  $("themeToggle").addEventListener("click", () => saveTheme(nextTheme()).catch((e) => setGlobalNotice(e.message, "error")));
  $("themeLight").addEventListener("click", () => saveTheme("light").catch((e) => setGlobalNotice(e.message, "error")));
  $("themeDark").addEventListener("click", () => saveTheme("dark").catch((e) => setGlobalNotice(e.message, "error")));

  $("resetStats").addEventListener("click", async () => {
    const res = await send("RESET_STATS");
    if (res?.ok) {
      boot.stats = res.stats;
      renderStats();
    }
  });

  $("exportBtn").addEventListener("click", exportProfiles);
  $("importBtn").addEventListener("click", () => $("importInput").click());
  $("importInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!confirm("Импорт заменит текущие профили и настройки. Продолжить?")) return;
    await importProfiles(file);
  });

  $("enableVaultBtn").addEventListener("click", async () => {
    const password = $("vaultPassword").value;
    const confirmPassword = $("vaultPasswordConfirm").value;
    if (!password || password.length < 6) return setGlobalNotice("Пароль хранилища должен быть не короче 6 символов.", "error");
    if (password !== confirmPassword) return setGlobalNotice("Пароли не совпадают.", "error");
    const res = await send("ENABLE_VAULT", { password });
    if (!res?.ok) return showError(res);
    await applyResponse(res);
    $("vaultPassword").value = "";
    $("vaultPasswordConfirm").value = "";
    setGlobalNotice("Защита включена. Теперь логины и пароли профилей хранятся в зашифрованном виде.", "success");
  });

  $("unlockVaultBtn").addEventListener("click", async () => {
    const password = $("vaultUnlockPassword").value;
    const res = await send("UNLOCK_VAULT", { password });
    if (!res?.ok) return showError(res);
    await applyResponse(res);
    $("vaultUnlockPassword").value = "";
    setGlobalNotice("Хранилище разблокировано.", "success");
  });

  $("lockVaultBtn").addEventListener("click", async () => {
    const res = await send("LOCK_VAULT");
    if (!res?.ok) return showError(res);
    await applyResponse(res);
    setGlobalNotice("Хранилище заблокировано.", "success");
  });

  async function disableVaultFlow() {
    let password = "";
    if (!boot?.vault?.unlocked) {
      password = prompt("Введите пароль хранилища, чтобы отключить защиту.") || "";
      if (!password) return;
    }
    const res = await send("DISABLE_VAULT", { password });
    if (!res?.ok) return showError(res);
    await applyResponse(res);
    setGlobalNotice("Защита выключена. Логины и пароли снова хранятся в локальном хранилище без шифрования.", "success");
  }

  $("disableVaultBtn").addEventListener("click", () => disableVaultFlow().catch((e) => setGlobalNotice(e.message, "error")));
  $("disableVaultBtnLocked").addEventListener("click", () => disableVaultFlow().catch((e) => setGlobalNotice(e.message, "error")));

  $("addRouteBtn").addEventListener("click", async () => {
    const rule = routeFormValue();
    const error = validateRoute(rule);
    if (error) return setGlobalNotice(error, "error");
    const routingRules = [...(boot?.settings?.routingRules || []), rule];
    const res = await send("SAVE_SETTINGS", { patch: { routingRules } });
    if (!res?.ok) return showError(res);
    await applyResponse(res);
    $("routeValue").value = "";
    setGlobalNotice("Правило маршрутизации сохранено.", "success");
  });

  $("clearRoutesBtn").addEventListener("click", async () => {
    if (!boot?.settings?.routingRules?.length) return;
    if (!confirm("Удалить все правила маршрутизации?")) return;
    const res = await send("SAVE_SETTINGS", { patch: { routingRules: [] } });
    if (!res?.ok) return showError(res);
    await applyResponse(res);
  });
}

init().catch((error) => {
  setGlobalNotice(error?.message || "Не удалось инициализировать popup.", "error");
});
