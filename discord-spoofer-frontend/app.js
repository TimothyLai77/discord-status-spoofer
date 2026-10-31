/**
 * Discord Status Spoofer — frontend logic.
 *
 * Plain browser JavaScript, no build step and no dependencies. Talks to the
 * Express API with `fetch`:
 *   - GET  /api/getUser       -> { username }
 *   - GET  /api/getStatus     -> { currentStatus }
 *   - GET  /api/getHeartbeat  -> { intervalMs, ackAgoMs, serverNowMs }
 *   - POST /api/updateStatus  -> { newStatus, isAfk }
 *   - GET  /api/gateway/connection   -> { state, ready }
 *   - POST /api/gateway/disconnect   -> { state, ready }
 *   - POST /api/gateway/reconnect    -> { state, ready }
 *
 * The UI mirrors Discord's own status picker: a card headed by the account's
 * Discord username and avatar (showing a live presence dot), with one pill
 * button per status. The active status is highlighted in blurple and its
 * presence color tints the avatar dot and the "Current status" label (see
 * styles.css).
 *
 * A footer line reports gateway liveness: how long ago the gateway last
 * acked a heartbeat, with a dot that goes amber past the 2-interval
 * threshold the gateway itself uses to detect a dead ("zombie") connection,
 * red when the API cannot be reached at all, and neutral grey while the
 * gateway is disconnected on purpose (no fault to look for).
 *
 * Above it, a Gateway row reports the connection state and holds the
 * Disconnect/Reconnect toggle: POST /api/gateway/disconnect drops the gateway
 * session and keeps it down, POST /api/gateway/reconnect starts a fresh one.
 * While the session is deliberately down the status buttons are greyed out
 * (there is no socket to send a presence on) and the status label reads
 * "disconnected".
 */

"use strict";

/**
 * Single source of truth for the statuses the app can set.
 *
 * @typedef {Object} StatusMeta
 * @property {string} label Human-readable button label.
 * @property {string} color Discord presence color for this status.
 * @property {string} icon  Inline SVG markup for the button icon.
 */

/**
 * Build the status dot icon for a status.
 *
 * Each icon is a small SVG drawn in the status color. DND adds a white minus
 * bar and invisible is drawn as a dashed ring (Discord's hollow marker),
 * matching how Discord renders each presence state.
 *
 * @param {string} status One of the keys of STATUS_META.
 * @param {string} color Presence color.
 * @returns {string} Inline SVG markup (18x18 viewBox 24).
 */
function statusIcon(status, color) {
  if (status === "dnd") {
    return (
      `<svg viewBox="0 0 24 24" aria-hidden="true">` +
      `<circle cx="12" cy="12" r="10" fill="${color}"/>` +
      `<rect x="6.5" y="10.75" width="11" height="2.5" rx="1.25" fill="#fff"/>` +
      `</svg>`
    );
  }
  if (status === "idle") {
    // Crescent moon to read as "away", filled in the status color so it
    // stays correct over any button background state.
    return (
      `<svg viewBox="0 0 24 24" aria-hidden="true">` +
      `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" ` +
      `fill="${color}"/>` +
      `</svg>`
    );
  }
  if (status === "invisible") {
    // Dashed hollow ring, like Discord's invisible marker.
    return (
      `<svg viewBox="0 0 24 24" aria-hidden="true">` +
      `<circle cx="12" cy="12" r="8.5" fill="none" stroke="${color}" ` +
      `stroke-width="2.5" stroke-dasharray="3.5 3"/>` +
      `</svg>`
    );
  }
  // online (and any fallback): solid filled dot.
  return (
    `<svg viewBox="0 0 24 24" aria-hidden="true">` +
    `<circle cx="12" cy="12" r="10" fill="${color}"/>` +
    `</svg>`
  );
}

/** @type {Record<string, StatusMeta>} */
const STATUS_META = {
  online: { label: "Online", color: "var(--status-online)", icon: "" },
  idle: { label: "Idle", color: "var(--status-idle)", icon: "" },
  dnd: { label: "Do Not Disturb", color: "var(--status-dnd)", icon: "" },
  invisible: {
    label: "Invisible",
    color: "var(--status-invisible)",
    icon: "",
  },
};

// Fill in the icons now that statusIcon is defined.
for (const [key, meta] of Object.entries(STATUS_META)) {
  meta.icon = statusIcon(key, meta.color);
}

/**
 * What each gateway connection state means for the UI.
 *
 * `state` is one of the four values GET /api/gateway/connection reports;
 * `label` is the state word in the Gateway row and `action` is the verb the
 * toggle button offers in that state. Anything outside these four (an
 * unexpected value, a failed call) renders as "unknown".
 *
 * @type {Record<string, { label: string, action: string }>}
 */
const CONNECTION_META = {
  connected: { label: "Connected", action: "Disconnect" },
  connecting: { label: "Connecting…", action: "Disconnect" },
  reconnecting: { label: "Reconnecting…", action: "Disconnect" },
  disconnected: { label: "Disconnected", action: "Reconnect" },
};

/**
 * Cache of the DOM nodes we touch, resolved once on load.
 * @type {{grid: HTMLElement, value: HTMLElement, user: HTMLElement,
 *   error: HTMLElement, heartbeatLine: HTMLElement, heartbeatText: HTMLElement,
 *   connectionRow: HTMLElement, connectionState: HTMLElement,
 *   connectionBtn: HTMLButtonElement, connectionBtnLabel: HTMLElement}}
 */
let els = null;

/**
 * Fetch the account's Discord username from the API.
 * @returns {Promise<string>} The username of the account the token belongs to.
 */
async function fetchUser() {
  const res = await fetch("/api/getUser");
  if (!res.ok) {
    throw new Error(`getUser failed (${res.status})`);
  }
  const data = await res.json();
  return data.username;
}

/**
 * Fetch the account's current status from the API.
 * @returns {Promise<string>} The current status string.
 */
async function fetchStatus() {
  const res = await fetch("/api/getStatus");
  if (!res.ok) {
    throw new Error(`getStatus failed (${res.status})`);
  }
  const data = await res.json();
  return data.currentStatus;
}

/**
 * Fetch gateway heartbeat liveness from the API.
 * @returns {Promise<{ intervalMs: number, ackAgoMs: number, serverNowMs: number }>}
 *   ackAgoMs is computed on the server (its clock), so it is trustworthy
 *   without the browser clock agreeing with it.
 */
async function fetchHeartbeat() {
  const res = await fetch("/api/getHeartbeat");
  if (!res.ok) {
    throw new Error(`getHeartbeat failed (${res.status})`);
  }
  const data = await res.json();
  return {
    intervalMs: data.intervalMs,
    ackAgoMs: data.ackAgoMs,
    serverNowMs: data.serverNowMs,
  };
}

/**
 * Ask the backend to change the account's status.
 * @param {string} status Target status.
 * @returns {Promise<void>}
 */
async function sendStatus(status) {
  const res = await fetch("/api/updateStatus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newStatus: status, isAfk: true }),
  });
  if (!res.ok) {
    throw new Error(`updateStatus failed (${res.status})`);
  }
}

/**
 * Fetch the gateway connection state.
 *
 * This route answers in every state, disconnected included — that is exactly
 * the state the toggle button has to be rendered in, so it must not 500 the
 * way the session-data routes do.
 * @returns {Promise<{ state: string, ready: boolean }>}
 */
async function fetchConnection() {
  const res = await fetch("/api/gateway/connection");
  if (!res.ok) {
    throw new Error(`gateway connection check failed (${res.status})`);
  }
  const data = await res.json();
  return { state: data.state, ready: data.ready };
}

/**
 * Ask the backend to drop or re-open the gateway connection.
 * @param {"disconnect"|"reconnect"} action Which way to toggle.
 * @returns {Promise<void>}
 */
async function sendGatewayAction(action) {
  const res = await fetch(`/api/gateway/${action}`, { method: "POST" });
  if (!res.ok) {
    // The 500 body carries the reason (e.g. the socket died before the
    // session started), which says more than the bare status code.
    const reason = await res.text().catch(() => "");
    throw new Error(reason || `${action} failed (${res.status})`);
  }
}

/**
 * Render one pill button for a status.
 * @param {string} status Status key.
 * @returns {HTMLButtonElement}
 */
function makeButton(status) {
  const meta = STATUS_META[status];
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "status-btn";
  btn.dataset.status = status;
  btn.setAttribute("aria-pressed", "false");
  btn.innerHTML = `<span class="status-btn__icon">${meta.icon}</span>` +
    `<span>${meta.label}</span>`;
  btn.addEventListener("click", () => onStatusClick(status, btn));
  return btn;
}

/**
 * Populate the button grid from STATUS_META.
 * @returns {void}
 */
function renderButtons() {
  const frag = document.createDocumentFragment();
  for (const status of Object.keys(STATUS_META)) {
    frag.appendChild(makeButton(status));
  }
  els.grid.replaceChildren(frag);
}

/**
 * Reflect a status in the UI: tint the body (avatar dot + label color),
 * set the label text, and mark the matching button as pressed.
 *
 * @param {string|null} status Status key, or null to show a neutral state.
 * @param {string} [labelText] Optional override for the label text
 *   (e.g. "loading…" or "unavailable").
 * @returns {void}
 */
function applyStatus(status, labelText) {
  if (status && STATUS_META[status]) {
    document.body.dataset.status = status;
    els.value.textContent = STATUS_META[status].label;
  } else {
    delete document.body.dataset.status;
    els.value.textContent = labelText ?? status ?? "unknown";
  }

  for (const btn of els.grid.querySelectorAll(".status-btn")) {
    btn.setAttribute(
      "aria-pressed",
      String(btn.dataset.status === status)
    );
  }
}

/**
 * Show or hide the inline error message.
 * @param {string|null} message Error text, or null to clear.
 * @returns {void}
 */
function showError(message) {
  if (message) {
    els.error.textContent = message;
    els.error.hidden = false;
  } else {
    els.error.hidden = true;
  }
}

/**
 * Enable or disable every status button (used while a request is in flight,
 * and while the gateway is deliberately disconnected — with no socket, a
 * presence update can only fail).
 * @param {boolean} disabled
 * @returns {void}
 */
function setButtonsDisabled(disabled) {
  const off = Boolean(disabled) || isGatewayDown();
  for (const btn of els.grid.querySelectorAll(".status-btn")) {
    btn.disabled = off;
  }
}

/**
 * Paint the Gateway row: state word, dot colour (through data-state, see
 * styles.css) and the verb the toggle button offers.
 *
 * Also records the state in `gatewayState`, which is what the status buttons
 * and the status label read from ("disconnected" + greyed out, "Reconnect").
 * @param {string|null} state State from GET /api/gateway/connection, or null
 *   when that call failed.
 * @returns {void}
 */
function paintConnection(state) {
  gatewayState = CONNECTION_META[state] ? state : null;
  const meta = gatewayState ? CONNECTION_META[gatewayState] : null;

  els.connectionRow.dataset.state = gatewayState ?? "unknown";
  els.connectionState.textContent = meta ? meta.label : "unknown";
  els.connectionBtnLabel.textContent = meta ? meta.action : "unavailable";
  els.connectionBtn.disabled = !meta;
}

/** Milliseconds between status/heartbeat polls (first poll, retries, and the
 *  steady-state re-fetch that keeps the heartbeat age counter fresh). */
const RETRY_DELAY_MS = 5000;

/**
 * Milliseconds between ticks of the heartbeat age counter. The data itself
 * only refreshes every RETRY_DELAY_MS; the ticker just ages the last sample
 * so the number moves in ones, like a working connection should.
 */
const TICK_DELAY_MS = 1000;

/** Pending poll timer: the next refresh() (retry after failure, or the
 *  steady-state poll). */
let pollTimer = null;

/** Pending ticker timer for the heartbeat age counter. */
let tickTimer = null;

/**
 * Newest gateway connection state from GET /api/gateway/connection, or null
 * when that call failed. Written by paintConnection(), read by isGatewayDown().
 * @type {string|null}
 */
let gatewayState = null;

/**
 * True when the gateway is deliberately disconnected (the user pressed the
 * toggle): nothing will reconnect on its own, and a presence update would
 * fail for lack of a socket.
 * @returns {boolean}
 */
function isGatewayDown() {
  return gatewayState === "disconnected";
}

/**
 * Newest heartbeat sample, or null when the last /api/getHeartbeat failed.
 * @type {{ intervalMs: number, ackAgoMs: number, arrivedAtMs: number }|null}
 */
let heartbeatSample = null;

/**
 * Format an age in milliseconds as short human text ("3s", "1m 12s").
 * @param {number} ms Age in milliseconds.
 * @returns {string}
 */
function formatAge(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Age of the newest heartbeat ack, in milliseconds, aged locally.
 * Uses only browser-clock deltas added to the server-computed age, so a
 * browser clock that disagrees with the server cannot produce a negative
 * (or jumpy) counter.
 * @returns {number|null} Age in ms, or null when there is no sample.
 */
function heartbeatAgeMs() {
  if (!heartbeatSample) {
    return null;
  }
  return heartbeatSample.ackAgoMs + (Date.now() - heartbeatSample.arrivedAtMs);
}

/**
 * Paint the heartbeat liveness line from the current sample.
 * Called on every fetch and on every 1s tick.
 *
 * Health thresholds mirror the gateway: it forces a reconnect once
 * 2 * interval has passed without an ack, so "ok" here means the same thing
 * the client considers a live connection.
 * @returns {void}
 */
function paintHeartbeat() {
  const ageMs = heartbeatAgeMs();

  if (ageMs === null) {
    if (isGatewayDown()) {
      // Not a dead server: the API answered fine, there is simply no session
      // to ack heartbeats because the user closed it. Saying "can't reach the
      // server" here would send them looking in the wrong place.
      els.heartbeatLine.dataset.health = "off";
      els.heartbeatText.textContent = "gateway disconnected — heartbeats stopped";
      return;
    }
    els.heartbeatLine.dataset.health = "dead";
    els.heartbeatText.textContent = "heartbeat check failed — can't reach the server";
    return;
  }

  const { intervalMs } = heartbeatSample;
  const healthy = Boolean(intervalMs) && ageMs < 2 * intervalMs;

  els.heartbeatLine.dataset.health = healthy ? "ok" : "stale";
  els.heartbeatText.textContent = healthy
    ? `heartbeat acked ${formatAge(ageMs)} ago`
    : `no heartbeat ack for ${formatAge(ageMs)}`;
}

/** True once the username has been loaded — it never changes, so fetch once. */
let nameLoaded = false;

/**
 * Load the username into the card title, unless it is already there.
 *
 * The backend 500s on /api/getUser while the gateway is still connecting,
 * so the first call after a container start usually fails. In that case the
 * title reads "unavailable" and the next refresh() re-runs this — the same
 * retry loop that recovers the status also recovers the name.
 * @returns {Promise<void>}
 */
async function loadName() {
  if (nameLoaded) return;
  try {
    els.user.textContent = await fetchUser();
    nameLoaded = true;
  } catch {
    els.user.textContent = "unavailable";
  }
}

/**
 * Load the current status and heartbeat liveness and paint the UI. Runs on
 * startup, after every status change, and then every RETRY_DELAY_MS in the
 * steady state (see pollTimer). A failing backend 500s while the gateway is
 * still (re)connecting, which is expected right after a container start or a
 * network blip, so the same loop doubles as the retry loop. A heartbeat
 * failure paints a red line but does not add its own timer — it rides on the
 * same poll.
 * @returns {Promise<void>}
 */
async function refresh() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  // The username is static, so loadName() stops hitting the API once it
  // succeeds; failures ride on this same retry timer.
  await loadName();

  // Status, heartbeat and connection state are independent requests, so they
  // all go out together: a slow or failing route must not delay the others.
  const [statusResult, heartbeatResult, connectionResult] = await Promise.allSettled([
    fetchStatus(),
    fetchHeartbeat(),
    fetchConnection(),
  ]);

  // Connection state is applied first: it decides how the status is labelled
  // (a deliberate disconnect reads "disconnected", not a scary "couldn't load
  // your status") and whether the status buttons are usable at all.
  paintConnection(
    connectionResult.status === "fulfilled" ? connectionResult.value.state : null
  );

  if (isGatewayDown()) {
    // Nothing to load and nothing to retry — the socket is down because the
    // user asked for it. Say so plainly, with no error banner.
    applyStatus(null, "disconnected");
    showError(null);
  } else if (statusResult.status === "fulfilled") {
    showError(null);
    applyStatus(statusResult.value);
  } else {
    applyStatus(null, "unavailable");
    const err = statusResult.reason;
    showError(
      "Couldn't load your status. " +
        (err && err.message ? err.message : "Try again.") +
        " Retrying…"
    );
  }

  if (heartbeatResult.status === "fulfilled") {
    const data = heartbeatResult.value;
    heartbeatSample = {
      intervalMs: data.intervalMs,
      ackAgoMs: data.ackAgoMs,
      arrivedAtMs: Date.now(),
    };
  } else {
    heartbeatSample = null;
  }
  paintHeartbeat();

  // Poll again in every case, the disconnected one included. The heartbeat
  // counter needs its steady sample, and a gateway that comes back — a
  // Reconnect press in another tab, a container restart — has to be picked up
  // without a page reload.
  pollTimer = setTimeout(refresh, RETRY_DELAY_MS);

  // This is the end of any in-flight request: hand the buttons back. The
  // gateway-down case stays greyed out inside setButtonsDisabled().
  setButtonsDisabled(false);
}

/**
 * Handle a click on a status button: send the change, then re-sync.
 *
 * @param {string} status The status being requested.
 * @param {HTMLButtonElement} btn The clicked button.
 * @returns {Promise<void>}
 */
async function onStatusClick(status, btn) {
  setButtonsDisabled(true);
  btn.setAttribute("aria-pressed", "true");
  try {
    await sendStatus(status);
    applyStatus(status);
    showError(null);
    // Re-fetch so the UI reflects the server's authoritative state
    // (covers the gateway-not-ready edge case and any drift).
    await refresh();
  } catch (err) {
    showError(
      `Couldn't set status to ${STATUS_META[status].label}. ` +
        (err && err.message ? err.message : "Try again.")
    );
    await refresh();
  } finally {
    setButtonsDisabled(false);
  }
}

/**
 * Handle a click on the gateway toggle: drop the session when one is up, and
 * start a fresh one when the user took it down. Then re-sync, which repaints
 * the row (and re-enables the button) from the server's answer.
 * @returns {Promise<void>}
 */
async function onConnectionClick() {
  const action = isGatewayDown() ? "reconnect" : "disconnect";
  els.connectionBtn.disabled = true;
  els.connectionBtnLabel.textContent =
    action === "reconnect" ? "connecting…" : "disconnecting…";
  setButtonsDisabled(true);
  try {
    await sendGatewayAction(action);
    showError(null);
  } catch (err) {
    showError(
      `Couldn't ${action} the gateway. ` +
        (err && err.message ? err.message : "Try again.")
    );
  }
  // A disconnect answer is final; a reconnect answer is "connecting". The
  // 5s poll carries that on to "connected".
  await refresh();
}

/**
 * Entry point: cache DOM nodes, render buttons, do the initial fetch.
 * @returns {void}
 */
function init() {
  els = {
    grid: document.getElementById("statusGrid"),
    value: document.getElementById("statusValue"),
    user: document.getElementById("userName"),
    error: document.getElementById("error"),
    heartbeatLine: document.getElementById("heartbeatLine"),
    heartbeatText: document.getElementById("heartbeatText"),
    connectionRow: document.getElementById("connectionRow"),
    connectionState: document.getElementById("connectionState"),
    connectionBtn: document.getElementById("connectionBtn"),
    connectionBtnLabel: document.getElementById("connectionBtnLabel"),
  };
  renderButtons();
  els.connectionBtn.addEventListener("click", onConnectionClick);
  applyStatus(null, "loading…");
  setButtonsDisabled(true);
  // Age the heartbeat counter every second between fetches; paintHeartbeat()
  // is a no-op on data, so this is the only place the ticker touches.
  tickTimer = setInterval(paintHeartbeat, TICK_DELAY_MS);
  refresh().finally(() => setButtonsDisabled(false));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
