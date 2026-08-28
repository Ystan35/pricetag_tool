"use strict";

/* ============================================================
   Longwan Price Checker — app.js
   Talks only to the Price Tag Tool's local LAN server:
     GET  /api/lookup?barcode=<code>   -> product + system price
     GET  /api/health                  -> connectivity check
     POST /api/flags                   -> report a mismatch
   Nothing here calls api.php directly or leaves the LAN.
   ============================================================ */

const CONFIG_KEY = "pc_config";
const PENDING_KEY = "pc_pending";
const REQUEST_TIMEOUT_MS = 6000;

// ---------- LAN auto-discovery ----------
// Must match flag_server.py's DEFAULT_PORT.
const FLAG_SERVER_PORT = 8765;
const SCAN_TIMEOUT_MS = 500; // per-address probe; most addresses have nothing listening
const SCAN_CONCURRENCY = 40;
// Phones can't ask the OS "what's my subnet?" from a web page (browsers
// deliberately don't expose it, and Chrome's mDNS host-candidate
// obfuscation blocks the old WebRTC trick too) -- so if there's no
// previously-saved address to infer a subnet from, fall back to guessing
// the handful of ranges small-business/home routers actually use.
const FALLBACK_SUBNETS = ["192.168.100", "192.168.1", "192.168.0", "192.168.50", "10.0.0"];

// ---------- Config / storage helpers ----------
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore corrupt config */ }
  return { serverUrl: "", deviceId: makeDeviceId() };
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function makeDeviceId() {
  if (window.crypto && crypto.randomUUID) return "phone-" + crypto.randomUUID().slice(0, 8);
  return "phone-" + Math.random().toString(36).slice(2, 10);
}

function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore corrupt queue */ }
  return [];
}

function savePending(list) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
}

let config = loadConfig();
if (!config.deviceId) {
  config.deviceId = makeDeviceId();
  saveConfig(config);
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const barcodeInput = $("barcode-input");
const clearBtn = $("clear-btn");
const resultCard = $("result-card");
const productName = $("product-name");
const productCode = $("product-code");
const systemPriceEl = $("system-price");
const matchBtn = $("match-btn");
const mismatchBtn = $("mismatch-btn");
const resetBtn = $("reset-btn");
const toastEl = $("toast");

const pendingBtn = $("pending-btn");
const pendingBadge = $("pending-badge");
const pendingBackdrop = $("pending-backdrop");
const pendingSheet = $("pending-sheet");
const pendingList = $("pending-list");
const closePendingBtn = $("close-pending-btn");
const retryPendingBtn = $("retry-pending-btn");

const settingsBtn = $("settings-btn");
const settingsBackdrop = $("settings-backdrop");
const settingsSheet = $("settings-sheet");
const serverUrlInput = $("server-url-input");
const testConnBtn = $("test-conn-btn");
const saveSettingsBtn = $("save-settings-btn");
const connDot = $("conn-dot");
const connText = $("conn-text");
const scanServersBtn = $("scan-servers-btn");
const scanStatusEl = $("scan-status");
const scanResultsEl = $("scan-results");

// ---------- State ----------
let currentProduct = null; // {description, price, uom, barcode, scan_code}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, kind = "") {
  toastEl.textContent = msg;
  toastEl.className = "show" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ""; }, 3200);
}

// ---------- Fetch with timeout ----------
async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    let body = null;
    try { body = await resp.json(); } catch (e) { /* no body */ }
    return { ok: resp.ok, status: resp.status, body };
  } finally {
    clearTimeout(t);
  }
}

function serverBase() {
  return (config.serverUrl || "").replace(/\/+$/, "");
}

// ============================================================
// Lookup
// ============================================================
async function lookupBarcode(code) {
  code = (code || "").trim();
  if (!code) return;

  if (!serverBase()) {
    toast("Set the Price Tag Tool address in Settings first", "err");
    openSettings();
    return;
  }

  resultCard.classList.add("show", "loading");
  productName.textContent = "Looking up…";
  productCode.textContent = code;
  systemPriceEl.textContent = "--.--";
  clearCompareSelection();
  matchBtn.disabled = true;
  mismatchBtn.disabled = true;

  try {
    const { ok, body } = await fetchJson(
      `${serverBase()}/api/lookup?barcode=${encodeURIComponent(code)}`
    );
    resultCard.classList.remove("loading");

    if (!ok || !body || body.status !== "ok" || !body.items || !body.items.length) {
      const msg = (body && body.msg) || "Product not found";
      productName.textContent = "Not found";
      productCode.textContent = code;
      toast(msg, "err");
      currentProduct = null;
      return;
    }

    const product = body.items[0];
    // api.php sometimes returns prices with a thousands comma (e.g.
    // "4,199.00") for amounts over 999 -- normalize once here so every
    // downstream use (display, flag record) sees a plain numeric string.
    product.price = cleanPriceString(product.price);
    currentProduct = product;
    productName.textContent = (product.description || "").trim() || "(no description)";
    const shownCode = product.scan_code || product.barcode || code;
    productCode.textContent = `${shownCode}${product.uom ? "  ·  " + product.uom : ""}`;
    systemPriceEl.textContent = formatPrice(product.price);
    matchBtn.disabled = false;
    mismatchBtn.disabled = false;
  } catch (e) {
    resultCard.classList.remove("loading");
    productName.textContent = "Connection failed";
    productCode.textContent = code;
    toast("Couldn't reach the Price Tag Tool — check Settings", "err");
    currentProduct = null;
  }
}

// Strips a thousands comma (and stray whitespace) so parseFloat doesn't
// truncate at the separator, e.g. "4,199.00" -> "4199.00".
function cleanPriceString(v) {
  if (v === null || v === undefined) return v;
  return String(v).replace(/,/g, "").trim();
}

function formatPrice(v) {
  const n = parseFloat(cleanPriceString(v));
  return isNaN(n) ? "--.--" : n.toFixed(2);
}

// ============================================================
// Compare — one tap does the whole job, no confirm step
// ============================================================
// Staff only ever eyeball the printed tag next to the system price shown
// here and tap one of two buttons -- there's no price entry to compare
// against, so this is a judgment call, not a numeric diff. Tapping either
// button immediately commits (reset + flag-if-different) rather than
// arming a separate "confirm" action, since a second tap just slows staff
// down on the floor without adding any real safety.
function clearCompareSelection() {
  matchBtn.classList.remove("selected");
  mismatchBtn.classList.remove("selected");
}

function onMatchClick() {
  if (!currentProduct) return;
  toast("Marked as matching", "ok");
  resetScan();
}

async function onMismatchClick() {
  if (!currentProduct) return;
  matchBtn.disabled = true;
  mismatchBtn.disabled = true;
  const flag = buildFlag();

  if (!serverBase()) {
    queueFlag(flag);
    toast("No server set — saved to Pending", "err");
    resetScan();
    return;
  }

  try {
    await sendFlag(flag);
    toast("Flagged for reprint ✓", "ok");
  } catch (e) {
    queueFlag(flag);
    toast("Offline — saved, will retry automatically", "");
  }
  resetScan();
}

matchBtn.addEventListener("click", onMatchClick);
mismatchBtn.addEventListener("click", onMismatchClick);

// ============================================================
// Flagging (with offline queue)
// ============================================================
function buildFlag() {
  return {
    barcode: currentProduct.barcode || currentProduct.scan_code || "",
    scan_code: currentProduct.scan_code || currentProduct.barcode || "",
    description: currentProduct.description || "",
    uom: currentProduct.uom || "",
    system_price: currentProduct.price,
    // Staff tap "Different" rather than typing the shelf price, so there's
    // no shelf value to record -- null means "flagged, exact tag price
    // not captured", not a $0 tag.
    shelf_price: null,
    scanned_at: new Date().toISOString(),
  };
}

async function sendFlag(flag) {
  const { ok, body } = await fetchJson(`${serverBase()}/api/flags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: config.deviceId, flags: [flag] }),
  });
  if (!ok || !body || body.status !== "ok") {
    throw new Error((body && body.msg) || "send failed");
  }
}

function queueFlag(flag) {
  const pending = loadPending();
  pending.push({ ...flag, _localId: Date.now() + "-" + Math.random().toString(36).slice(2, 7) });
  savePending(pending);
  renderPendingBadge();
}

function renderPendingBadge() {
  const n = loadPending().length;
  if (n > 0) {
    pendingBadge.textContent = n > 99 ? "99+" : String(n);
    pendingBadge.classList.add("show");
  } else {
    pendingBadge.classList.remove("show");
  }
}

async function retryPending(showToasts = true) {
  if (!serverBase()) return;
  const pending = loadPending();
  if (!pending.length) return;

  let sent = 0;
  const remaining = [];
  for (const flag of pending) {
    const { _localId, ...payload } = flag;
    try {
      await sendFlag(payload);
      sent++;
    } catch (e) {
      remaining.push(flag);
    }
  }
  savePending(remaining);
  renderPendingBadge();
  renderPendingList();
  if (showToasts && sent > 0) {
    toast(`Sent ${sent} pending flag${sent > 1 ? "s" : ""} ✓`, "ok");
  }
}

function renderPendingList() {
  const pending = loadPending();
  if (!pending.length) {
    pendingList.innerHTML = `<div class="pending-empty">Nothing pending — all flags sent.</div>`;
    return;
  }
  pendingList.innerHTML = pending
    .slice()
    .reverse()
    .map((f) => {
      const name = escapeHtml(f.description || f.barcode || "Unknown item");
      return `<div class="pending-item">
        <div class="row1"><span>${name}</span></div>
        <div class="row2"><span class="from">RM ${escapeHtml(formatPrice(f.system_price))}</span> system
          → <span class="to">${f.shelf_price != null ? "RM " + escapeHtml(String(f.shelf_price)) : "marked different"}</span></div>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ============================================================
// Reset / scan flow
// ============================================================
function resetScan() {
  currentProduct = null;
  resultCard.classList.remove("show", "loading");
  productName.textContent = "—";
  productCode.textContent = "—";
  systemPriceEl.textContent = "--.--";
  clearCompareSelection();
  matchBtn.disabled = true;
  mismatchBtn.disabled = true;
  barcodeInput.value = "";
  barcodeInput.focus();
}

barcodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    lookupBarcode(barcodeInput.value);
  }
});

resetBtn.addEventListener("click", resetScan);
clearBtn.addEventListener("click", resetScan);

// ============================================================
// Settings sheet
// ============================================================
function openSettings() {
  serverUrlInput.value = config.serverUrl || "";
  updateConnStatus("idle");
  settingsBackdrop.classList.add("show");
  settingsSheet.classList.add("show");
}
function closeSettings() {
  settingsBackdrop.classList.remove("show");
  settingsSheet.classList.remove("show");
}

function updateConnStatus(state, msg) {
  connDot.className = "dot" + (state === "idle" ? "" : " " + state);
  const messages = {
    idle: "Not tested yet",
    ok: msg || "Connected",
    err: msg || "Couldn't connect",
    pending: "Testing…",
  };
  connText.textContent = messages[state] || messages.idle;
}

async function testConnection() {
  const url = serverUrlInput.value.trim().replace(/\/+$/, "");
  if (!url) {
    updateConnStatus("err", "Enter an address first");
    return;
  }
  updateConnStatus("pending");
  try {
    const { ok, body } = await fetchJson(`${url}/api/health`);
    if (ok && body && body.status === "ok") {
      updateConnStatus("ok", `Connected — branch ${body.branch_id}, ${body.pending} pending on desktop`);
    } else {
      updateConnStatus("err", "Reached the address but got an unexpected reply");
    }
  } catch (e) {
    updateConnStatus("err", "Couldn't connect — check the address and Wi-Fi");
  }
}

settingsBtn.addEventListener("click", openSettings);
settingsBackdrop.addEventListener("click", closeSettings);
testConnBtn.addEventListener("click", testConnection);
saveSettingsBtn.addEventListener("click", () => {
  config.serverUrl = serverUrlInput.value.trim().replace(/\/+$/, "");
  saveConfig(config);
  closeSettings();
  toast("Settings saved", "ok");
  retryPending(false);
});

// ============================================================
// LAN auto-discovery
// ============================================================
// Probes one candidate address's /api/health. Almost every address probed
// has nothing listening, so a short timeout matters a lot here -- at the
// default REQUEST_TIMEOUT_MS (6s) scanning a /24 would take forever.
async function probeHost(scheme, subnet, host) {
  const url = `${scheme}://${subnet}.${host}:${FLAG_SERVER_PORT}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!resp.ok) return null;
    const body = await resp.json().catch(() => null);
    if (body && body.status === "ok") {
      return { url, branch_id: body.branch_id, hostname: body.hostname || "", pending: body.pending };
    }
  } catch (e) {
    // Expected for almost every address: connection refused, timed out,
    // nothing there. Not worth surfacing per-address.
  } finally {
    clearTimeout(t);
  }
  return null;
}

function candidateSubnets() {
  const subnets = [];
  const saved = (config.serverUrl || serverUrlInput.value || "").trim();
  const m = saved.match(/(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}/);
  if (m) subnets.push(m[1]); // most likely hit: same Wi-Fi as last time, IP just changed
  for (const s of FALLBACK_SUBNETS) {
    if (!subnets.includes(s)) subnets.push(s);
  }
  return subnets;
}

function selectServer(hit) {
  serverUrlInput.value = hit.url;
  config.serverUrl = hit.url;
  saveConfig(config);
  toast(`Connected — ${hit.hostname || hit.url}`, "ok");
  testConnection();
  retryPending(false);
}

function renderScanResults(found) {
  scanResultsEl.innerHTML = "";
  found
    .slice()
    .sort((a, b) => a.url.localeCompare(b.url))
    .forEach((hit) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "scan-result-row";
      const label = hit.hostname ? `Branch ${hit.branch_id} — ${hit.hostname}` : `Branch ${hit.branch_id}`;
      row.textContent = `${label} (${hit.url.replace(/^https?:\/\//, "")})`;
      row.addEventListener("click", () => selectServer(hit));
      scanResultsEl.appendChild(row);
    });
}

async function scanForServers() {
  // A page loaded over HTTPS can't fetch a plain-HTTP address ("mixed
  // content" -- the browser blocks it outright), so only that page's own
  // scheme is worth trying.
  const scheme = location.protocol === "https:" ? "https" : "http";
  const subnets = candidateSubnets();
  const targets = [];
  for (const subnet of subnets) {
    for (let host = 1; host <= 254; host++) targets.push([subnet, host]);
  }

  scanServersBtn.disabled = true;
  scanResultsEl.innerHTML = "";
  const found = [];
  let done = 0;
  const updateStatus = () => {
    scanStatusEl.textContent =
      `Scanning ${subnets.map((s) => s + ".x").join(", ")} — ${done}/${targets.length}` +
      (found.length ? ` — ${found.length} found` : "");
  };
  updateStatus();

  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const [subnet, host] = targets[idx++];
      const hit = await probeHost(scheme, subnet, host);
      done++;
      if (hit) {
        found.push(hit);
        renderScanResults(found);
      }
      if (done % 8 === 0 || done === targets.length) updateStatus();
    }
  }
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));

  scanServersBtn.disabled = false;
  if (found.length === 0) {
    scanStatusEl.textContent = "No servers found on this Wi-Fi — enter the address manually";
  } else if (found.length === 1) {
    scanStatusEl.textContent = "Found 1 server";
    selectServer(found[0]);
  } else {
    scanStatusEl.textContent = `Found ${found.length} servers — tap one to use it`;
  }
}

scanServersBtn.addEventListener("click", scanForServers);

// ============================================================
// Pending sheet
// ============================================================
function openPending() {
  renderPendingList();
  pendingBackdrop.classList.add("show");
  pendingSheet.classList.add("show");
}
function closePending() {
  pendingBackdrop.classList.remove("show");
  pendingSheet.classList.remove("show");
}
pendingBtn.addEventListener("click", openPending);
pendingBackdrop.addEventListener("click", closePending);
closePendingBtn.addEventListener("click", closePending);
retryPendingBtn.addEventListener("click", () => retryPending(true).then(renderPendingList));

// ============================================================
// Init
// ============================================================
function init() {
  renderPendingBadge();

  if (!config.serverUrl) {
    setTimeout(openSettings, 300);
  }

  barcodeInput.focus();

  // Retry pending flags periodically and whenever the app regains focus/network.
  setInterval(() => retryPending(true), 20000);
  window.addEventListener("online", () => retryPending(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retryPending(true);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is a nice-to-have */ });
  }
}

init();
