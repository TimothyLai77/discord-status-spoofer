"use strict";

/**
 * One-off diagnostic: can a session that IDENTIFIES as the official
 * DESKTOP client beat a real, open desktop client for the account's
 * effective status?
 *
 * Model under test (from manual testing): the account's effective status
 * is the status of the highest-priority active session; official clients
 * outrank web-type sessions. If two sessions claim the same client type,
 * the tie may go to the most recent write — this probe tests exactly that.
 *
 * REQUIREMENT: run with the Discord DESKTOP client OPEN on this account
 * (its status acts as the "incumbent"). The probe identifies as the
 * desktop client and sets "idle" — if the account visibly flips to idle
 * (or the session receives a PRESENCE_UPDATE echo for "idle"), a
 * desktop-typed session can win; if the account keeps the desktop
 * client's status, the real client is authenticated beyond the payload.
 *
 * Usage:
 *   node scripts/diag-desktop-priority.js
 *
 * Exit codes: 0 = observation completed, 1 = connection died, 2 = no token.
 */

require("dotenv").config();

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_VERSION = 10;
const PROBE_MS = 2_000;
const OBSERVE_MS = 90_000;

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
    console.log(`[desktop +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
}

const t0 = Date.now();
let ready = false;
let ourUserId = null;
let sawIdleEcho = false;
const otherEchoes = [];

/**
 * Print the verdict and exit.
 * @param {number} code
 */
function finish(code) {
    if (sawIdleEcho) {
        log("VERDICT: WON — the desktop-typed session's write became the effective status (idle echo received). Same-type ties go to the latest write: a re-assertion loop can hold the status.");
    } else {
        log("VERDICT: LOST (no idle echo) — the real desktop client kept winning. Check the official client: if the account stayed on the desktop client's status, the real client is authenticated beyond the payload and a desktop-typed spoof cannot beat it.");
    }
    if (otherEchoes.length) log(`other own-user echoes seen: ${JSON.stringify(otherEchoes)}`);
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
        if (typeof p.s === "number") seq = p.s;
        if (p.op === 10) {
            clearTimeout(helloTimeout);
            heartbeatMs = p.d.heartbeat_interval;
            setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq ?? null })), heartbeatMs);
            ws.send(JSON.stringify({ op: 1, d: null }));
            // IDENTIFY — exact official DESKTOP client shape.
            const identify = {
                op: 2,
                d: {
                    token,
                    properties: { os: "windows", browser: "Discord", device: "Discord" },
                    compress: false,
                    intents: 0,
                    presence: { status: "online", since: 0, afk: false, activities: [] },
                },
            };
            ws.send(JSON.stringify(identify));
            log(`-> IDENTIFY (official desktop shape): ${redact(JSON.stringify(identify.d))}`);
        } else if (p.op === 0 && p.t === "READY") {
            ready = true;
            ourUserId = p.d.user.id;
            log(`READY (session ${p.d.session_id}, user ${p.d.user.username}, id ${ourUserId})`);
            setTimeout(() => {
                if (!ready || ws.readyState !== 1) return;
                const probe = { status: "idle", since: 0, afk: false, activities: [] };
                ws.send(JSON.stringify({ op: 3, d: probe }));
                log(`-> PROBE op3 (desktop-typed session): ${JSON.stringify(probe)}`);
                log(">>> WATCH THE ACCOUNT: does it flip to IDLE (moon) or stay on the desktop client's status? <<<");
            }, PROBE_MS);
            setTimeout(() => finish(0), OBSERVE_MS);
        } else if (p.op === 0 && p.t === "PRESENCE_UPDATE") {
            if (p.d?.user?.id === ourUserId) {
                if (p.d.status === "idle") {
                    sawIdleEcho = true;
                    log(`<- ECHO own PRESENCE_UPDATE: idle — EFFECTIVE STATUS FLIPPED`);
                } else {
                    otherEchoes.push({ status: p.d.status, afk: p.d.afk });
                    log(`<- own PRESENCE_UPDATE: status=${p.d.status} afk=${p.d.afk} (not idle)`);
                }
            }
        } else if (p.op !== 0 || p.t === "HEARTBEAT_ACK") {
            log(`<- op=${p.op}${p.t ? ` t=${p.t}` : ""}`);
        }
    };
    ws.onclose = (ev) => {
        log(`CLOSED code=${ev.code} reason=${ev.reason || "(none)"} ready=${ready}`);
        process.exit(1);
    };
    ws.onerror = () => { /* onclose follows */ };

    let seq = null;
    const helloTimeout = setTimeout(() => {
        log("gave up waiting for HELLO");
        process.exit(1);
    }, 15_000);
    helloTimeout.unref?.();
})();
