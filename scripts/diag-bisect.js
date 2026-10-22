"use strict";

/**
 * One-off diagnostic: bisect the IDENTIFY vs. op-3-frame discriminator.
 *
 * Background: Discord silently ignores this session's presence writes
 * (op 3 AND the IDENTIFY `presence` field) while the session stays healthy.
 * The earlier diag-presence-echo.js varied IDENTIFY `properties` and the op 3
 * frame shape (since/client_status) together, but always with the app's
 * IDENTIFY (intents 9, minimal presence object). The official web client
 * identifies with `intents: 0` and a FULL presence object — never tested.
 *
 * This script runs ONE session that varies the two axes independently:
 *
 *   IDENTIFY: official web client shape
 *     properties {os: windows, browser: Chrome, device: "Chrome on Windows"}
 *     compress: false, intents: 0,
 *     presence: {status: "online", since: 0, afk: false, activities: []}
 *
 *   Probe A (t≈2s): op 3 in the APP's frame shape -> status "idle"
 *     {status, since: Date.now(), afk: false, activities: []}
 *   Probe B (t≈52s): op 3 in the OFFICIAL web client frame shape -> "dnd"
 *     {status, since: 0, afk: false, activities: []}
 *
 * Each probe targets a different status, so an applied change is detectable
 * even if the echo mechanism were dead (the user can also watch the status
 * in the official client during the run: it should flip idle -> dnd).
 *
 * Verdicts (printed at the end):
 *   A=APPLIED  B=APPLIED  -> payload is not the discriminator at all
 *                            (both shapes work with the official IDENTIFY);
 *                            the app's IDENTIFY (intents/presence) is the cause
 *   A=IGNORED  B=APPLIED  -> the op 3 FRAME shape is the discriminator
 *                            (since: 0 vs timestamp, official fields)
 *   A=IGNORED  B=IGNORED  -> payload fully exonerated; the discriminator is
 *                            session-level (fingerprint, session type, ...)
 *   A=APPLIED  B=IGNORED  -> odd; investigate (A changed status, B did not)
 *
 * Usage (run with the app container STOPPED so no session churn):
 *   node scripts/diag-bisect.js
 *
 * Exit codes: 0 = observation completed, 1 = connection died early,
 *             2 = no token.
 */

require("dotenv").config();

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_VERSION = 10;
const PROBE_A_MS = 2_000;   // after READY
const PROBE_B_MS = 52_000;  // after READY
const OBSERVE_MS = 100_000; // after READY

const token = process.env.TOKEN;
if (!token) {
    console.error("no TOKEN in environment/.env");
    process.exit(2);
}
const redact = (s) => s.split(token).join("<token>");

/**
 * Log a line with a relative offset.
 * @param {string} line
 */
function log(line) {
    console.log(`[bisect +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
}

const t0 = Date.now();

/** @type {Record<"A"|"B", boolean>} */
const applied = { A: false, B: null, B_SENT: false };
let ready = false;
let ourUserId = null;
let sawAnyEcho = false;

/**
 * Print the final verdict and exit.
 * @param {number} code
 */
function finish(code) {
    const a = applied.A ? "APPLIED" : "IGNORED";
    const b = !applied.B_SENT ? "NOT-SENT" : applied.B ? "APPLIED" : "IGNORED";
    log(`VERDICT: A(app frame, official IDENTIFY)=${a}  B(official frame, official IDENTIFY)=${b}`);
    if (applied.A && applied.B) {
        log("  -> both shapes applied: the IDENTIFY is the discriminator (the app sends intents 9 + a minimal presence object).");
    } else if (!applied.A && applied.B) {
        log("  -> official frame applied, app frame ignored: the op 3 FRAME shape is the discriminator.");
    } else if (!applied.A && !applied.B && applied.B_SENT) {
        log("  -> both ignored even with the official IDENTIFY: the payload is exonerated; the discriminator is session-level (client fingerprint / session type).");
    } else {
        log("  -> unexpected combination; inspect the log above.");
    }
    log(`  (any own-user PRESENCE_UPDATE echo seen at all: ${sawAnyEcho})`);
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
            // IDENTIFY — exact official web client shape.
            const identify = {
                op: 2,
                d: {
                    token,
                    properties: {
                        os: "windows",
                        browser: "Chrome",
                        device: "Chrome on Windows",
                    },
                    compress: false,
                    intents: 0,
                    presence: { status: "online", since: 0, afk: false, activities: [] },
                },
            };
            ws.send(JSON.stringify(identify));
            log(`-> IDENTIFY (official web shape): ${redact(JSON.stringify(identify.d))}`);
        } else if (p.op === 0 && p.t === "READY") {
            ready = true;
            ourUserId = p.d.user.id;
            log(`READY (session ${p.d.session_id}, user ${p.d.user.username}, id ${ourUserId})`);

            // Probe A: the app's op 3 frame shape, targeting "idle".
            setTimeout(() => {
                if (!ready || ws.readyState !== 1) return;
                const a = { status: "idle", since: Date.now(), afk: false, activities: [] };
                ws.send(JSON.stringify({ op: 3, d: a }));
                log(`-> PROBE A (app frame shape): ${JSON.stringify(a)}`);
            }, PROBE_A_MS);

            // Probe B: the official web client's op 3 frame shape, "dnd".
            setTimeout(() => {
                if (!ready || ws.readyState !== 1) return;
                applied.B_SENT = true;
                const b = { status: "dnd", since: 0, afk: false, activities: [] };
                ws.send(JSON.stringify({ op: 3, d: b }));
                log(`-> PROBE B (official frame shape): ${JSON.stringify(b)}`);
            }, PROBE_B_MS);

            setTimeout(() => finish(0), OBSERVE_MS);
        } else if (p.op === 0 && p.t === "PRESENCE_UPDATE") {
            if (p.d?.user?.id === ourUserId) {
                sawAnyEcho = true;
                log(`<- ECHO own PRESENCE_UPDATE: status=${p.d.status} afk=${p.d.afk} since=${p.d.since}`);
                // Attribute the echo to the probe that targeted that status.
                if (p.d.status === "idle") applied.A = true;
                if (p.d.status === "dnd") applied.B = true;
            }
        } else if (p.op !== 0 || p.t === "RESUMED" || p.t === "HEARTBEAT_ACK") {
            log(`<- op=${p.op}${p.t ? ` t=${p.t}` : ""}`);
        }
    };
    ws.onclose = (ev) => {
        log(`CLOSED code=${ev.code} reason=${ev.reason || "(none)"} ready=${ready}`);
        process.exit(1);
    };
    ws.onerror = () => { /* onclose follows */ };

    // Give up if HELLO never arrives.
    const helloTimeout = setTimeout(() => {
        log("gave up waiting for HELLO");
        process.exit(1);
    }, 15_000);
    helloTimeout.unref?.();
})();
