"use strict";

/**
 * One-off diagnostic: is Discord applying gateway op 3 (Presence Update)
 * frames from this user session?
 *
 * Background: since ~late Sept 2026 the app's presence updates stop taking
 * effect on the account while the session stays healthy (READY fires,
 * heartbeats ACK, no close codes) and manual status changes made in the
 * official client DO stick. The app-shaped run (mode "app") came back
 * IGNORED, so Discord is keying on something that differs between this
 * session and the official client's. The candidate differences are the
 * IDENTIFY properties, the `since` value (timestamp vs 0), and the
 * `client_status` field — so this script probes in different client
 * shapes:
 *
 *   1. Connect + IDENTIFY with the mode's properties
 *   2. On READY, send the mode's op 3 frame (status "dnd")
 *   3. Watch for 120s for the server's PRESENCE_UPDATE dispatch for OUR
 *      own user id — the echo that proves the server applied the change
 *   4. If no echo by +60s, send a second probe (status "idle")
 *
 * Modes (all three probe shapes came back IGNORED on 2026-10-20, so the
 * payload shape is NOT the discriminator):
 *   app      IDENTIFY + frame exactly as lib/discord-gateway.js does today
 *            (control — known to be IGNORED as of 2026-10-20)
 *   web      official web client shape: Chrome-on-Windows properties,
 *            since: 0, client_status { web: <status> } (IGNORED 2026-10-20)
 *   desktop  official desktop client shape: Discord properties,
 *            since: 0, client_status { desktop: <status> } (IGNORED 2026-10-20)
 *   echo-check  NO probes at all. Sanity check for the echo mechanism itself:
 *            while this session is alive, YOU change the status in the
 *            official Discord app. If the session receives the
 *            PRESENCE_UPDATE, the echo mechanism is alive and the IGNORED
 *            verdicts above are real; if it doesn't, the "echo" is no
 *            longer dispatched to own sessions and those verdicts are
 *            inconclusive.
 *
 * Verdicts (printed at the end):
 *   - "APPLIED"    — at least one echo arrived: op 3 works in this shape
 *   - "IGNORED"    — session survived, zero echoes: this shape is dropped
 *   - "ECHO-ALIVE" — (echo-check) the manual change was dispatched to this
 *                    session: echoes work, IGNORED verdicts are real
 *   - "NO-ECHO"    — (echo-check) the manual change was NOT dispatched:
 *                    the echo mechanism is dead, verdicts are inconclusive
 *   - "CLOSED"     — the connection died (see the close code in the log)
 *
 * Usage (inside the container image; the token is passed at runtime — it
 * is never baked into the image, see .dockerignore):
 *
 *   docker compose run --rm app node scripts/diag-presence-echo.js [app|web|desktop|echo-check]
 *
 * NOTE: run with the app container STOPPED. The app's reconnect loop
 * creates a fresh session every few seconds, and the server may refuse
 * new sessions (op 9, no READY) for an account that churns sessions
 * that fast. Run each mode as a SEPARATE run (fresh session per run).
 *
 * Exit codes: 0 = verdict reached (session survived 120s),
 *             1 = closed early (see log), 2 = usage/no token.
 */

require("dotenv").config();

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_VERSION = 10;
const OBSERVE_MS = 120_000;
const ECHO_CHECK_OBSERVE_MS = 300_000; // long: the user must click in the official app
const SECOND_PROBE_MS = 60_000;

/**
 * The client shapes under test. Each mode changes the IDENTIFY properties
 * and the op 3 frame shape together, so a mode that comes back APPLIED
 * tells us the discriminator is among the fields it changes.
 *
 * @typedef {Object} DiagMode
 * @property {string} label Human-readable name for the log.
 * @property {{os: string, browser: string, device: string}} properties
 *   IDENTIFY connection properties.
 * @property {(status: string) => Object} frame Builds the op 3 payload.
 */

/** @type {Record<string, DiagMode>} */
const MODES = {
    // Control: byte-identical to lib/discord-gateway.js (known IGNORED).
    app: {
        label: "app (lib/discord-gateway.js shape)",
        properties: { os: "linux", browser: "browser", device: "desktop" },
        frame: (status) => ({
            status,
            since: status === "online" ? null : Date.now(),
            afk: false,
            activities: [],
        }),
    },
    // Official web client shape: real browser strings, since 0, and the
    // per-device client_status map the web app sends with every change.
    web: {
        label: "web (official web client shape)",
        properties: { os: "windows", browser: "Chrome", device: "Chrome on Windows" },
        frame: (status) => ({
            status,
            since: 0,
            afk: false,
            activities: [],
            client_status: { web: status, desktop: null, mobile: null },
        }),
    },
    // Official desktop client shape: identifies as "Discord".
    desktop: {
        label: "desktop (official desktop client shape)",
        properties: { os: "windows", browser: "Discord", device: "Discord" },
        frame: (status) => ({
            status,
            since: 0,
            afk: false,
            activities: [],
            client_status: { web: null, desktop: status, mobile: null },
        }),
    },
    // No probes: validates that own-user PRESENCE_UPDATE dispatches are
    // still sent to a second session at all (the assumption the other
    // modes' verdicts rely on).
    "echo-check": {
        label: "echo-check (no probes; watch for a manual change made in the official client)",
        properties: { os: "linux", browser: "browser", device: "desktop" },
        frame: null,
    },
};

const mode = process.argv[2] ?? "app";
if (!(mode in MODES)) {
    console.error(`usage: node scripts/diag-presence-echo.js [${Object.keys(MODES).join("|")}]`);
    process.exit(2);
}

const token = process.env.TOKEN;
if (!token) {
    console.error("no TOKEN in environment/.env");
    process.exit(2);
}
const redact = (s) => s.split(token).join("<token>");

/**
 * Log a line with a relative offset so frame ordering is visible.
 * @param {string} line
 */
function log(line) {
    console.log(`[echo +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
}

const t0 = Date.now();

/** True once we saw the server echo one of our presence updates. */
let sawEcho = false;
let secondProbeSent = false;
let ready = false;

/**
 * Print the final verdict and exit.
 * @param {string} verdict "APPLIED", "IGNORED" or "CLOSED".
 * @param {number} code Process exit code.
 */
function finish(verdict, code) {
    if (verdict === "APPLIED") {
        log(`VERDICT: APPLIED [mode=${mode}] — the server echoed our presence update; op 3 works in the ${MODES[mode].label}.`);
    } else if (verdict === "IGNORED") {
        log(`VERDICT: IGNORED [mode=${mode}] — session survived 120s with zero presence echoes: Discord is silently dropping op 3 updates in the ${MODES[mode].label}.`);
    } else if (verdict === "ECHO-ALIVE") {
        log("VERDICT: ECHO-ALIVE — the manual change made in the official client WAS dispatched to this session: the echo mechanism works, so the IGNORED verdicts are real (Discord drops op 3 from this session type, not the official client's).");
    } else if (verdict === "NO-ECHO") {
        log("VERDICT: NO-ECHO — the manual change was NOT dispatched to this session: own-user presence echoes are gone, so the earlier IGNORED verdicts are inconclusive.");
    } else {
        log(`VERDICT: CLOSED [mode=${mode}] — the connection died before the observation finished; see the close code above.`);
    }
    process.exit(code);
}

(async () => {
    const res = await fetch(`${API_BASE}/gateway`);
    if (!res.ok) {
        console.error(`gateway fetch failed: http ${res.status}`);
        process.exit(1);
    }
    const { url } = await res.json();
    log(`connecting to ${url}?v=${GATEWAY_VERSION}&encoding=json`);

    const ws = new WebSocket(`${url}?v=${GATEWAY_VERSION}&encoding=json`);
    let heartbeatMs = 41_250;
    let ourUserId = null;

    ws.onmessage = (ev) => {
        let p;
        try {
            p = JSON.parse(ev.data);
        } catch {
            log(`<- non-JSON frame: ${String(ev.data).slice(0, 120)}`);
            return;
        }
        if (p.op === 10) {
            // HELLO — heartbeat immediately, then on the interval.
            clearTimeout(helloTimeout);
            heartbeatMs = p.d.heartbeat_interval;
            setInterval(() => {
                ws.send(JSON.stringify({ op: 1, d: null }));
            }, heartbeatMs);
            ws.send(JSON.stringify({ op: 1, d: null }));
            // IDENTIFY with the mode's connection properties.
            const identify = {
                op: 2,
                d: {
                    token,
                    intents: (1 << 0) | (1 << 3), // GUILDS | GUILD_PRESENCES
                    properties: MODES[mode].properties,
                    compress: false,
                    presence: { status: "online", afk: false },
                },
            };
            ws.send(JSON.stringify(identify));
            log(`-> IDENTIFY [mode=${mode}]: properties=${JSON.stringify(MODES[mode].properties)}`);
        } else if (p.op === 0 && p.t === "READY") {
            ready = true;
            ourUserId = p.d.user.id;
            log(`READY (session ${p.d.session_id}, user ${p.d.user.username}, id ${ourUserId})`);
            if (MODES[mode].frame) {
                const first = MODES[mode].frame("dnd");
                ws.send(JSON.stringify({ op: 3, d: first }));
                log(`-> op 3 presence [probe 1]: ${JSON.stringify(first)}`);
                // Second probe if the first one never gets an echo.
                setTimeout(() => {
                    if (!ready || sawEcho || secondProbeSent) return;
                    secondProbeSent = true;
                    const second = MODES[mode].frame("idle");
                    ws.send(JSON.stringify({ op: 3, d: second }));
                    log(`-> op 3 presence [probe 2, no echo yet]: ${JSON.stringify(second)}`);
                }, SECOND_PROBE_MS);
            } else {
                log(`>>> ECHO-CHECK: NOW change your status in the official Discord app (Do Not Disturb is fine) — I'm watching for ${(ECHO_CHECK_OBSERVE_MS / 1000)}s to see if this session receives it. <<<`);
            }
            // End of observation.
            const observeMs = MODES[mode].frame ? OBSERVE_MS : ECHO_CHECK_OBSERVE_MS;
            setTimeout(() => {
                if (!ready) return;
                if (MODES[mode].frame) finish(sawEcho ? "APPLIED" : "IGNORED", 0);
                else finish(sawEcho ? "ECHO-ALIVE" : "NO-ECHO", 0);
            }, observeMs);
        } else if (p.op === 0 && p.t === "PRESENCE_UPDATE") {
            // Only our own user's presence is interesting here.
            if (p.d?.user?.id === ourUserId) {
                sawEcho = true;
                log(`<- PRESENCE_UPDATE for our user: status=${p.d.status} afk=${p.d.afk} since=${p.d.since}`);
            }
        } else if (p.op !== 0 || p.t === "RESUMED" || p.t === "HEARTBEAT_ACK") {
            // Protocol frames + ACKs, no high-volume guild dispatches.
            log(`<- op=${p.op}${p.t ? ` t=${p.t}` : ""}`);
        }
    };
    ws.onclose = (ev) => {
        log(`CLOSED code=${ev.code} reason=${ev.reason || "(none)"} ready=${ready} sawEcho=${sawEcho}`);
        finish(ready && sawEcho ? "APPLIED" : "CLOSED", 1);
    };
    ws.onerror = () => { /* onclose follows */ };

    // Give up if HELLO never arrives. Must be cleared once HELLO does —
    // otherwise it kills the observation at 15s.
    const helloTimeout = setTimeout(() => {
        log("gave up waiting for HELLO");
        process.exit(1);
    }, 15_000);
    helloTimeout.unref?.();
})();
