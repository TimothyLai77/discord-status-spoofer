"use strict";

/**
 * Minimal Discord Gateway client for user accounts.
 *
 * Speaks the official Gateway protocol directly (the same protocol the
 * Discord web client uses) instead of relying on a third-party selfbot
 * library. Supports just what this app needs:
 *
 *  - connect / identify / heartbeat / READY
 *  - presence updates (opcode 4) + status tracking
 *  - session resume (opcode 6) with reconnect/backoff
 *
 * Uses Node's built-in global `WebSocket` (Node >= 22), so there are no
 * runtime dependencies.
 */

const { EventEmitter } = require("node:events");

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_VERSION = 10;

/** Gateway opcode constants. @see https://discord.com/developers/docs/topics/gateway-list */
const OPCODE = Object.freeze({
    DISPATCH: 0,
    HEARTBEAT: 1,
    IDENTIFY: 2,
    RESUME: 6,
    RECONNECT: 7,
    INVALID_SESSION: 9,
    HELLO: 10,
    HEARTBEAT_ACK: 11,
    PRESENCE_UPDATE: 4,
});

/** Intents requested at IDENTIFY time: GUILDS (1) | GUILD_PRESENCES (8). */
const INTENTS = (1 << 0) | (1 << 3);

/** Presence statuses accepted by the gateway. */
const VALID_STATUSES = new Set(["online", "idle", "dnd", "invisible"]);

/**
 * @typedef {"online"|"idle"|"dnd"|"invisible"} PresenceStatus
 */

/** Close codes meaning the current session can no longer be resumed. */
const NON_RESUMABLE_CLOSE_CODES = new Set([4007, 4008]); // invalid seq / already resumed

/**
 * @typedef {Object} DiscordGatewayOptions
 * @property {string} token Discord user token.
 * @property {string} [gatewayUrl] Full ws:// URL. Skips the /gateway fetch
 *   (mainly for tests).
 * @property {typeof WebSocket} [WebSocketImpl] WebSocket constructor to use.
 *   Defaults to the global one. Injected for tests.
 * @property {number} [reconnectBaseDelayMs] Base delay for reconnect
 *   backoff. Default 1000.
 */

class DiscordGateway extends EventEmitter {
    /**
     * @param {DiscordGatewayOptions} options
     */
    constructor({ token, gatewayUrl, WebSocketImpl, reconnectBaseDelayMs = 1000 }) {
        super();
        this.token = token;
        this.gatewayUrl = gatewayUrl;
        this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
        this.reconnectBaseDelayMs = reconnectBaseDelayMs;

        /** @type {WebSocket|null} */
        this.ws = null;
        /** @type {string|null} Session id from READY, used for RESUME. */
        this.sessionId = null;
        /** @type {number|null} Last dispatch sequence number. */
        this.seq = null;
        /** @type {Object|null} Our user object from READY. */
        this.user = null;
        /** @type {boolean} True once READY or RESUMED has been received. */
        this.ready = false;
        /** @type {PresenceStatus|null} Last status we set, reconciled with the server. */
        this.status = null;

        this._heartbeatIntervalMs = null;
        this._heartbeatTimer = null;
        this._lastAckMs = 0;
        this._reconnectDelayMs = reconnectBaseDelayMs;
        this._reconnectTimer = null;
        this._resumeTimer = null;
        this._closing = false;
        /** True once IDENTIFY/RESUME has been sent (connect() resolved). */
        this._connected = false;
    }

    /**
     * Connect to the gateway and start a session.
     * Resolves once IDENTIFY (or RESUME) has been sent; readiness is signalled
     * by the `ready` / `resumed` events.
     * @returns {Promise<void>}
     */
    async connect() {
        this._closing = false;
        const url = this.gatewayUrl ?? await this.#fetchGatewayUrl();
        await this.#openSocket(url);
    }

    /**
     * Update this account's presence status (opcode 4, Update Status).
     * @param {PresenceStatus} status New status.
     * @param {boolean} [afk] Whether to mark the account AFK. Mostly
     *   cosmetic for user accounts.
     * @returns {Promise<void>} Resolves once the frame has been sent.
     * @throws {Error} If the status is invalid or the socket is not open.
     */
    setPresence(status, afk = false) {
        if (!VALID_STATUSES.has(status)) {
            return Promise.reject(new Error(`invalid status: ${status}`));
        }
        if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
            return Promise.reject(new Error("gateway is not connected"));
        }
        this.status = status;
        this.#send({
            op: OPCODE.PRESENCE_UPDATE,
            d: { status, afk, since: null, activities: [] },
        });
        this.emit("presence-set", status);
        return Promise.resolve();
    }

    /**
     * Close the connection without reconnecting.
     * @returns {void}
     */
    disconnect() {
        this._closing = true;
        this.#stopHeartbeat();
        this.#clearResumeTimer();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        const ws = this.ws;
        this.ws = null;
        this.ready = false;
        if (ws) {
            try { ws.close(1000); } catch { /* already closed */ }
        }
    }

    /**
     * Fetch the current gateway url from the official API.
     * @returns {Promise<string>} ws:// URL with version + encoding query params.
     */
    async #fetchGatewayUrl() {
        const res = await fetch(`${API_BASE}/gateway`);
        if (!res.ok) {
            throw new Error(`failed to fetch gateway url (http ${res.status})`);
        }
        const { url } = await res.json();
        return `${url}?v=${GATEWAY_VERSION}&encoding=json`;
    }

    /**
     * Open the WebSocket and attach protocol handlers.
     * @param {string} url
     * @returns {Promise<void>} Resolves once IDENTIFY/RESUME has been sent.
     * @private
     */
    #openSocket(url) {
        return new Promise((resolve, reject) => {
            const ws = new this.WebSocketImpl(url);
            this.ws = ws;
            let sessionStarted = false;

            ws.onopen = () => {
                // Nothing to do until HELLO arrives; the protocol is
                // server-initiated.
            };
            ws.onmessage = (event) => {
                if (this.ws !== ws) return; // stale socket
                this.#onMessage(event.data, () => {
                    if (!sessionStarted) {
                        sessionStarted = true;
                        this._connected = true;
                        resolve();
                    }
                });
            };
            ws.onclose = (event) => {
                if (this.ws !== ws) return; // stale socket
                this.ws = null;
                this.#onClose(event.code);
                if (!sessionStarted) reject(new Error(`gateway closed before session started (code ${event.code})`));
            };
            ws.onerror = () => { /* onclose always follows; handled there */ };
        });
    }

    /**
     * Handle a raw gateway packet.
     * @param {string} raw JSON text.
     * @param {() => void} onSessionStarted Called once IDENTIFY/RESUME went out.
     * @private
     */
    #onMessage(raw, onSessionStarted) {
        /** @type {{op: number, s?: number, t?: string, d?: any}} */
        let packet;
        try {
            packet = JSON.parse(raw);
        } catch {
            return;
        }
        if (typeof packet.s === "number") this.seq = packet.s;

        switch (packet.op) {
            case OPCODE.HELLO:
                this.#onHello(packet.d, onSessionStarted);
                break;
            case OPCODE.HEARTBEAT:
                // Server-requested immediate heartbeat.
                this.#sendHeartbeat();
                break;
            case OPCODE.HEARTBEAT_ACK:
                this._lastAckMs = Date.now();
                break;
            case OPCODE.RECONNECT:
                this.#reconnect("gateway requested reconnect (op 7)");
                break;
            case OPCODE.INVALID_SESSION:
                if (!packet.d) this.sessionId = null;
                this.#reconnect("invalid session (op 9)");
                break;
            case OPCODE.DISPATCH:
                this.#onDispatch(packet.t, packet.d);
                break;
            default:
                // Opcodes added by Discord in the future are ignored.
                break;
        }
    }

    /**
     * Start the heartbeat loop and send IDENTIFY (or RESUME later).
     * @param {{heartbeat_interval: number}} hello
     * @param {() => void} onSessionStarted
     * @private
     */
    #onHello({ heartbeat_interval }, onSessionStarted) {
        this._heartbeatIntervalMs = heartbeat_interval;
        this._lastAckMs = Date.now();
        this.#startHeartbeat();

        if (this.sessionId) {
            // Existing session: try to resume it (the server keeps our
            // presence state across a resume).
            this.#send({
                op: OPCODE.RESUME,
                d: { token: this.token, session_id: this.sessionId, seq: this.seq },
            });
            this.#startResumeTimer();
        } else {
            this.#send({
                op: OPCODE.IDENTIFY,
                d: {
                    token: this.token,
                    intents: INTENTS,
                    properties: {
                        os: "linux",
                        browser: "discord-status-spoofer",
                        device: "discord-status-spoofer",
                    },
                    compress: false,
                    presence: { status: "online", afk: false },
                },
            });
        }
        onSessionStarted();
    }

    /**
     * Handle a dispatch event (opcode 0).
     * @param {string} type Event name (READY, PRESENCE_UPDATE, ...).
     * @param {any} data Event payload.
     * @private
     */
    #onDispatch(type, data) {
        if (type === "READY") {
            this.sessionId = data.session_id;
            this.user = data.user;
            this.ready = true;
            this._reconnectDelayMs = this.reconnectBaseDelayMs;
            this.#clearResumeTimer();
            this.emit("ready", data.user);
        } else if (type === "RESUMED") {
            this.ready = true;
            this._reconnectDelayMs = this.reconnectBaseDelayMs;
            this.#clearResumeTimer();
            this.emit("resumed");
        } else if (type === "PRESENCE_UPDATE") {
            // Reconcile our tracked status with the server's view. Other
            // users' presence updates are ignored.
            if (data?.user?.id === this.user?.id && data.status !== this.status) {
                this.status = data.status;
                this.emit("status", data.status);
            }
        }
        // Other dispatches (GUILD_CREATE, ...) are ignored.
    }

    /**
     * Handle the socket closing.
     * @param {number} code Close code.
     * @private
     */
    #onClose(code) {
        this.#stopHeartbeat();
        this.#clearResumeTimer();
        this.ready = false;
        if (this._closing) return;
        if (code === 4004) {
            // Authentication failed — retrying will not help.
            this.emit("fatal", new Error(
                "gateway authentication failed (close code 4004) — check your token"
            ));
            return;
        }
        this.emit("close", code);
        if (typeof code === "number" && NON_RESUMABLE_CLOSE_CODES.has(code)) {
            this.sessionId = null; // force a fresh IDENTIFY
        }
        // If connect() has not resolved yet, it will reject and the caller
        // owns the retry. Once resolved, this class owns reconnection.
        if (this._connected) {
            this.#reconnect(`socket closed with code ${code}`);
        }
    }

    /**
     * Schedule a reconnect with exponential backoff (base → 30s cap).
     * If a session id exists, the next connect will attempt RESUME.
     * @param {string} reason Human-readable trigger, for logging.
     * @private
     */
    #reconnect(reason) {
        if (this._closing || this._reconnectTimer) return;
        this.emit("reconnecting", { reason, delayMs: this._reconnectDelayMs });
        const delay = this._reconnectDelayMs;
        this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, 30_000);
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            try { ws.close(4000); } catch { /* already closed */ }
        }
        // Intentionally NOT unref()'d: while reconnecting the socket is
        // gone, so this timer must keep the process alive.
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect().catch((err) => {
                this.emit("error", err);
                this.#reconnect(`connect failed: ${err.message}`);
            });
        }, delay);
    }

    /**
     * Give up on resuming if RESUMED does not arrive within 30s.
     * @private
     */
    #startResumeTimer() {
        this.#clearResumeTimer();
        this._resumeTimer = setTimeout(() => {
            this._resumeTimer = null;
            this.sessionId = null;
            this.seq = null;
            this.#reconnect("session was not resumed in time");
        }, 30_000);
        this._resumeTimer.unref?.();
    }

    /**
     * Clear the resume timer if set.
     * @private
     */
    #clearResumeTimer() {
        if (this._resumeTimer) {
            clearTimeout(this._resumeTimer);
            this._resumeTimer = null;
        }
    }

    /**
     * Start the heartbeat timer (first beat goes out immediately, per spec).
     * @private
     */
    #startHeartbeat() {
        this.#stopHeartbeat();
        this.#sendHeartbeat();
        this._heartbeatTimer = setInterval(() => {
            this.#sendHeartbeat();
            // Zombie connection detection: no ACK within 2 intervals.
            if (Date.now() - this._lastAckMs > 2 * this._heartbeatIntervalMs) {
                this.#reconnect("no heartbeat ack (zombie connection)");
            }
        }, this._heartbeatIntervalMs);
        this._heartbeatTimer.unref?.();
    }

    /**
     * Stop the heartbeat timer.
     * @private
     */
    #stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    /**
     * Send a heartbeat (opcode 1) with the last seq (or null).
     * @private
     */
    #sendHeartbeat() {
        this.#send({ op: OPCODE.HEARTBEAT, d: this.seq });
    }

    /**
     * Send a JSON frame if the socket is open.
     * @param {Object} payload
     * @private
     */
    #send(payload) {
        if (this.ws && this.ws.readyState === 1 /* OPEN */) {
            this.ws.send(JSON.stringify(payload));
        }
    }
}

module.exports = { DiscordGateway, OPCODE };
