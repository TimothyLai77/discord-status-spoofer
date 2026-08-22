"use strict";

/**
 * Protocol tests for the native Discord gateway client.
 *
 * Runs against a mock WebSocket that speaks just enough of the gateway
 * protocol (HELLO → IDENTIFY/RESUME → dispatches → acks), so no network
 * access or real token is needed:  node --test
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { DiscordGateway } = require("../lib/discord-gateway");

/**
 * Mock WebSocket speaking a subset of the Discord gateway protocol.
 * Mirrors the browser-style API surface used by DiscordGateway
 * (onopen/onmessage/onclose/onerror/send/close/readyState).
 */
class MockWebSocket {
    /** Every constructed socket, in order. */
    static instances = [];
    /** User object delivered in READY. */
    static USER = { id: "u-1", username: "tester" };
    /** When true, the socket closes (1006) before sending HELLO. */
    static failFast = false;

    /** @param {string} url */
    constructor(url) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        /** @type {Array<Object>} Frames sent by the client, parsed. */
        this.sent = [];
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        MockWebSocket.instances.push(this);
        setImmediate(() => {
            if (MockWebSocket.failFast) {
                this.close(1006);
                return;
            }
            this.readyState = 1; // OPEN
            this.onopen?.();
            this.push({ op: 10, d: { heartbeat_interval: 50 } });
        });
    }

    /**
     * Deliver a raw gateway packet to the client.
     * @param {Object} packet
     */
    push(packet) {
        setImmediate(() => this.onmessage?.({ data: JSON.stringify(packet) }));
    }

    /**
     * Handle a frame from the client and reply like the gateway would.
     * @param {string} data JSON frame.
     */
    send(data) {
        const frame = JSON.parse(data);
        this.sent.push(frame);
        switch (frame.op) {
            case 2: // IDENTIFY
                this.push({ op: 0, s: 1, t: "READY", d: { session_id: "session-1", user: MockWebSocket.USER } });
                break;
            case 6: // RESUME
                this.push({ op: 0, s: 2, t: "RESUMED", d: {} });
                break;
            case 1: // HEARTBEAT
                this.push({ op: 11, d: null });
                break;
            case 4: // PRESENCE_UPDATE — echo the server's view
                this.push({
                    op: 0, s: 3, t: "PRESENCE_UPDATE",
                    d: { user: { id: MockWebSocket.USER.id }, status: frame.d.status },
                });
                break;
            default:
                break;
        }
    }

    /**
     * Close the socket.
     * @param {number} [code] Close code delivered to onclose.
     */
    close(code = 1006) {
        if (this.readyState === 3) return;
        this.readyState = 3; // CLOSED
        setImmediate(() => this.onclose?.({ code }));
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for an event on an EventEmitter, with a timeout.
 * @template T
 * @param {import("node:events").EventEmitter} emitter
 * @param {string} event
 * @param {number} [timeoutMs]
 * @returns {Promise<T[]>} Event arguments.
 */
function waitFor(emitter, event, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`timed out waiting for "${event}"`)),
            timeoutMs,
        );
        emitter.once(event, (...args) => {
            clearTimeout(timer);
            resolve(args);
        });
    });
}

/**
 * Create a gateway wired to the mock and wait until READY.
 * @param {Object} [options] Extra DiscordGateway options.
 * @returns {Promise<DiscordGateway>}
 */
async function connectReady(options = {}) {
    const gateway = new DiscordGateway({
        token: "token-123",
        WebSocketImpl: MockWebSocket,
        gatewayUrl: "ws://mock/gateway",
        reconnectBaseDelayMs: 20,
        ...options,
    });
    const readyPromise = waitFor(gateway, "ready");
    gateway.connect().catch(() => { /* asserted per-test */ });
    await readyPromise;
    return gateway;
}

test("identifies with token + intents and emits ready", async () => {
    const gateway = await connectReady();
    const socket = MockWebSocket.instances.at(-1);
    const identify = socket.sent.find((f) => f.op === 2);

    assert.equal(identify.d.token, "token-123");
    assert.equal(identify.d.intents, (1 << 0) | (1 << 3)); // GUILDS | GUILD_PRESENCES
    assert.equal(identify.d.presence.status, "online");
    assert.equal(gateway.sessionId, "session-1");
    assert.equal(gateway.user.id, "u-1");
    assert.equal(gateway.ready, true);
    gateway.disconnect();
});

test("setPresence rejects before the socket is open", async () => {
    const gateway = new DiscordGateway({
        token: "token-123",
        WebSocketImpl: MockWebSocket,
        gatewayUrl: "ws://mock/gateway",
    });
    await assert.rejects(gateway.setPresence("idle"), /not connected/);
    await assert.rejects(gateway.setPresence("bogus"), /invalid status/);
});

test("setPresence sends op 4 and tracks the status", async () => {
    const gateway = await connectReady();
    const socket = MockWebSocket.instances.at(-1);

    await gateway.setPresence("dnd", false);

    const frame = socket.sent.at(-1);
    assert.deepEqual(frame, {
        op: 4,
        d: {
            status: "dnd",
            afk: false,
            since: 0,
            activities: [],
            client_status: { web: false, desktop: true, mobile: false },
        },
    });
    assert.equal(gateway.status, "dnd");
    gateway.disconnect();
});

test("server PRESENCE_UPDATE reconciles the tracked status", async () => {
    const gateway = await connectReady();
    const socket = MockWebSocket.instances.at(-1);

    const statusChange = waitFor(gateway, "status");
    // Simulate the account's status changing from another client.
    socket.push({
        op: 0, s: 4, t: "PRESENCE_UPDATE",
        d: { user: { id: MockWebSocket.USER.id }, status: "idle" },
    });

    assert.deepEqual(await statusChange, ["idle"]);
    assert.equal(gateway.status, "idle");
    gateway.disconnect();
});

test("sends heartbeats on the hello interval, carrying the last seq", async () => {
    const gateway = await connectReady(); // mock heartbeat_interval = 50ms
    const socket = MockWebSocket.instances.at(-1);

    await sleep(180);

    const beats = socket.sent.filter((f) => f.op === 1);
    assert.ok(beats.length >= 2, `expected >= 2 heartbeats, got ${beats.length}`);
    assert.equal(beats[0].d, null); // first beat before any dispatch
    assert.ok(beats.some((f) => f.d === 1), "later beats carry the last seq");
    gateway.disconnect();
});

test("resumes the session after a reconnect (no re-identify)", async () => {
    const gateway = await connectReady();
    await gateway.setPresence("idle", false);
    const firstSocket = MockWebSocket.instances.at(-1);

    firstSocket.close(4009); // gateway-side "reconnect" close

    const resumed = waitFor(gateway, "resumed");
    await resumed;

    const secondSocket = MockWebSocket.instances.at(-1);
    assert.notEqual(secondSocket, firstSocket);
    const resume = secondSocket.sent.find((f) => f.op === 6);
    assert.ok(resume, "expected a RESUME frame");
    assert.equal(resume.d.token, "token-123");
    assert.equal(resume.d.session_id, "session-1");
    // READY is s:1; the mock's PRESENCE_UPDATE echo for the op-4 frame is s:3.
    assert.equal(resume.d.seq, 3);
    assert.ok(!secondSocket.sent.some((f) => f.op === 2), "must not re-IDENTIFY");
    assert.equal(gateway.status, "idle"); // presence survived the resume
    assert.equal(gateway.ready, true);
    gateway.disconnect();
});

test("emits fatal on auth failure (close 4004) and does not reconnect", async () => {
    const gateway = await connectReady();
    const socket = MockWebSocket.instances.at(-1);
    const instanceCount = MockWebSocket.instances.length;

    const fatal = waitFor(gateway, "fatal");
    socket.close(4004);
    const [error] = await fatal;
    assert.match(error.message, /4004/);
    assert.equal(gateway.ready, false);

    await sleep(100); // a reconnect (if any) would happen at 20ms
    assert.equal(MockWebSocket.instances.length, instanceCount, "no new socket after fatal");
});

test("rejects connect() when the socket dies before the session starts", async () => {
    MockWebSocket.failFast = true;
    try {
        const gateway = new DiscordGateway({
            token: "token-123",
            WebSocketImpl: MockWebSocket,
            gatewayUrl: "ws://mock/gateway",
        });
        await assert.rejects(gateway.connect(), /before session started/);
    } finally {
        MockWebSocket.failFast = false;
    }
});

test("a failed reconnect emits 'error' (index.js must listen for it)", async () => {
    const gateway = await connectReady();
    const firstSocket = MockWebSocket.instances.at(-1);

    // The next socket (the reconnect attempt) dies before HELLO, so the
    // reconnect's connect() rejects. Without an 'error' listener on the
    // gateway, this emit would crash the process.
    MockWebSocket.failFast = true;
    try {
        const errorPromise = waitFor(gateway, "error", 3000);
        firstSocket.close(4009); // triggers a reconnect at ~20ms
        const [error] = await errorPromise;
        assert.match(error.message, /before session started/);
    } finally {
        MockWebSocket.failFast = false;
        gateway.disconnect();
    }
});

test("disconnect() prevents reconnection", async () => {
    const gateway = await connectReady();
    const instanceCount = MockWebSocket.instances.length;

    gateway.disconnect();
    await sleep(100);
    assert.equal(gateway.ready, false);
    assert.equal(MockWebSocket.instances.length, instanceCount, "no new socket after disconnect");
});
