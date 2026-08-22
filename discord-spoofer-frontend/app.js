/**
 * Discord Status Spoofer — frontend logic.
 *
 * Plain browser JavaScript, no build step and no dependencies. Talks to the
 * Express API with `fetch`:
 *   - GET  /api/getStatus     -> { currentStatus }
 *   - POST /api/updateStatus  -> { newStatus, isAfk }
 *
 * The UI mirrors Discord's own status picker: a card with the account avatar
 * (showing a live presence dot) and one pill button per status. The active
 * status is highlighted in blurple and its presence color tints the avatar
 * dot and the "Current status" label (see styles.css).
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
 * Cache of the DOM nodes we touch, resolved once on load.
 * @type {{grid: HTMLElement, value: HTMLElement, error: HTMLElement}}
 */
let els = null;

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
 * Enable or disable every status button (used while a request is in flight).
 * @param {boolean} disabled
 * @returns {void}
 */
function setButtonsDisabled(disabled) {
  for (const btn of els.grid.querySelectorAll(".status-btn")) {
    btn.disabled = disabled;
  }
}

/** Milliseconds between automatic status-fetch retries. */
const RETRY_DELAY_MS = 5000;

/** Pending retry timer, if the last fetch failed. */
let retryTimer = null;

/**
 * Load the current status and paint the UI. Called on startup and after
 * every successful change to stay in sync with the server. After a failure
 * it re-runs itself on a timer: the backend returns 500 while the gateway
 * is still (re)connecting, which is expected right after a container start
 * or a network blip and clears itself.
 * @returns {Promise<void>}
 */
async function refresh() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  try {
    const status = await fetchStatus();
    showError(null);
    applyStatus(status);
  } catch (err) {
    applyStatus(null, "unavailable");
    showError(
      "Couldn't load your status. " +
        (err && err.message ? err.message : "Try again.") +
        " Retrying…"
    );
    retryTimer = setTimeout(refresh, RETRY_DELAY_MS);
  }
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
 * Entry point: cache DOM nodes, render buttons, do the initial fetch.
 * @returns {void}
 */
function init() {
  els = {
    grid: document.getElementById("statusGrid"),
    value: document.getElementById("statusValue"),
    error: document.getElementById("error"),
  };
  renderButtons();
  applyStatus(null, "loading…");
  setButtonsDisabled(true);
  refresh().finally(() => setButtonsDisabled(false));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
