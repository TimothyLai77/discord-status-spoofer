"use strict";

/**
 * One-off diagnostic: isolate what triggers the 4002 ("decode error") close
 * that happens a few seconds after READY.
 *
 * Usage (inside the container image; token comes from the baked-in .env):
 *
 *   node scripts/diag-4002.js none        # connect + READY, send NO presence update (control)
 *   node scripts/diag-4002.js minimal     # op 4 with only {status}
 *   node scripts/diag-4002.js docs        # documented Update Status shape, no client_status
 *   node scripts/diag-4002.js current     # the app's pre-9fa039b frame (afk:true, since:null)
 *   node scripts/diag-4002.js official    # the app's current frame (with client_status)
 *
 * NOTE: run with the app container STOPPED. The app's reconnect loop creates
 * a fresh session every few seconds, and the server may refuse new sessions
 * (op 9, no READY) for an account that churns sessions that fast.
 *
 * The IDENTIFY frame is byte-identical to lib/discord-gateway.js. After
 * READY (and the optional presence update) it only heartbeats and observes
 * for 120s, logging every frame in both directions (token redacted).
 *
 * Exit codes: 0 = session survived 120s, 1 = closed (see the close code in
 * the log — process.exit truncates codes to 8 bits, so the code itself is
 * only trustworthy in the printed line).
 */

require("dotenv").config();

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_VERSION = 10;
const OBSERVE_MS = 120_000;

/** Presence payloads under test. */
const PRESENCE_VARIANTS = {
    // Absolute minimum: just the status field.
    minimal: { status: "online" },
    // The documented Update Status shape (status/since/activities/afk),
    // WITHOUT client_status (not a documented op 4 field).
    docs: { status: "online", afk: false, since: 0, activities: [] },
    // The app's frame before 9fa039b (afk leftover true, since null).
    current: { status: "online", afk: true, since: null, activities: [] },
    // The app's frame today (9fa039b): adds client_status.
    official: {
        status: "online",
        afk: false,
        since: 0,
        activities: [],
        client_status: { web: false, desktop: true, mobile: false },
    },
};

const mode = process.argv[2];
if (!mode || !(mode === "none" || mode in PRESENCE_VARIANTS)) {
    console.error("usage: node scripts/diag-4002.js none|current|official");
    process.exit(2);
}
const token = process.env.TOKEN;
if (!token) {
    console.error("no TOKEN in environment/.env");
    process.exit(2);
}
const redact = (s) => s.split(token).join("<token>");

/**
 * Log a line with an absolute-ish offset so frame ordering is visible.
 * @param {string} line
 */
function log(line) {
    console.log(`[diag +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
}

const t0 = Date.now();

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
    let ready = false;

    ws.onmessage = (ev) => {
        let p;
        try {
            p = JSON.parse(ev.data);
        } catch {
            log(`<- non-JSON frame: ${String(ev.data).slice(0, 120)}`);
            return;
        }
        // Keep the log focused: protocol frames + READY/RESUMED, skip the
        // high-volume guild/presence dispatches.
        if (p.op !== 0 || p.t === "READY" || p.t === "RESUMED" || p.t === "PRESENCE_UPDATE") {
            log(`<- op=${p.op}${p.t ? ` t=${p.t}` : ""}`);
        }
        if (p.op === 10) {
            // HELLO
            clearTimeout(helloTimeout);
            heartbeatMs = p.d.heartbeat_interval;
            setInterval(() => {
                ws.send(JSON.stringify({ op: 1, d: null }));
            }, heartbeatMs);
            ws.send(JSON.stringify({ op: 1, d: null }));
            const identify = {
                op: 2,
                d: {
                    token,
                    intents: (1 << 0) | (1 << 3), // GUILDS | GUILD_PRESENCES
                    properties: {
                        os: "linux",
                        browser: "browser",
                        device: "desktop",
                    },
                    compress: false,
                    presence: { status: "online", afk: false },
                },
            };
            ws.send(JSON.stringify(identify));
            log(`-> IDENTIFY (token redacted, same payload as the app)`);
        } else if (p.op === 0 && p.t === "READY") {
            ready = true;
            log(`READY (session ${p.d.session_id}, user ${p.d.user.username})`);
            if (mode !== "none") {
                const frame = { op: 4, d: PRESENCE_VARIANTS[mode] };
                ws.send(JSON.stringify(frame));
                log(`-> op 4 presence [${mode}]: ${JSON.stringify(frame.d)}`);
            } else {
                log("mode=none: intentionally sending NO presence update");
            }
            setTimeout(() => {
                if (ready) {
                    log(`SURVIVED ${OBSERVE_MS / 1000}s with mode=${mode} — session is stable`);
                    process.exit(0);
                }
            }, OBSERVE_MS);
        }
    };
    ws.onclose = (ev) => {
        log(`CLOSED code=${ev.code} reason=${ev.reason || "(none)"} mode=${mode} ready=${ready}`);
        process.exit(1);
    };
    ws.onerror = () => { /* onclose follows */ };

    // Give up if HELLO never arrives. Must be cleared once HELLO does —
    // otherwise it kills the observation at 15s (see: the first diag round).
    const helloTimeout = setTimeout(() => {
        log("gave up waiting for HELLO");
        process.exit(1);
    }, 15_000);
    helloTimeout.unref?.();
})();
