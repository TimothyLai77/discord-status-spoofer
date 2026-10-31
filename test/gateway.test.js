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
            case 3: // PRESENCE_UPDATE — echo the server's view
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

test("setPresence sends op 3 (Presence Update) and tracks the status", async () => {
    const gateway = await connectReady();
    const socket = MockWebSocket.instances.at(-1);

    const before = Date.now();
    await gateway.setPresence("dnd", false);
    const after = Date.now();

    // Regression: opcode 4 ("Voice State Update") is not a presence opcode —
    // the gateway rejects presence payloads on it with 4002 for user
    // sessions. Presence must go out on opcode 3.
    const frame = socket.sent.at(-1);
    assert.equal(frame.op, 3);
    assert.equal(frame.d.status, "dnd");
    assert.equal(frame.d.afk, false);
    assert.deepEqual(frame.d.activities, []);
    assert.ok(
        frame.d.since >= before && frame.d.since <= after,
        "non-online status carries a since timestamp"
    );
    assert.equal(gateway.status, "dnd");

    await gateway.setPresence("online", false);
    const onlineFrame = socket.sent.at(-1);
    assert.equal(onlineFrame.op, 3);
    assert.equal(onlineFrame.d.since, null, "online sends since:null like the working client");
    assert.equal(gateway.status, "online");
    gateway.disconnect();
});

test("setPresence online+afk sends a since timestamp (away state)", async () => {
    const gateway = await connectReady();
    const socket = MockWebSocket.instances.at(-1);

    const before = Date.now();
    await gateway.setPresence("online", true);
    const after = Date.now();

    // Regression: afk:true is what makes Discord's mobile app send push
    // notifications. Like the official client and discord.js, the away
    // state must carry an "away since" timestamp even while the status is
    // online — since:null + afk:true is a state the official client never
    // sends, and the account would not read as away.
    const frame = socket.sent.at(-1);
    assert.equal(frame.op, 3);
    assert.equal(frame.d.status, "online");
    assert.equal(frame.d.afk, true);
    assert.ok(
        frame.d.since >= before && frame.d.since <= after,
        "online+afk carries a since timestamp"
    );
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

test("heartbeatState() reports interval and ack time for /api/getHeartbeat", async () => {
    const beforeConnect = Date.now();
    const gateway = await connectReady(); // mock heartbeat_interval = 50ms

    const first = gateway.heartbeatState();
    assert.equal(first.intervalMs, 50, "interval comes from HELLO");
    assert.equal(first.ready, true);
    assert.ok(first.lastAckMs >= beforeConnect && first.lastAckMs <= Date.now(),
        "ack time is seeded when the session starts");

    // The mock acks every beat, so the ack time must keep moving forward —
    // this is the number /api/getHeartbeat ages and the UI colours.
    await sleep(160);
    const later = gateway.heartbeatState();
    assert.ok(later.lastAckMs > first.lastAckMs, "acks advance lastAckMs");
    assert.ok(Date.now() - later.lastAckMs < 2 * later.intervalMs,
        "stays inside the gateway's zombie-connection threshold");

    gateway.disconnect();
    // After disconnect the flag goes false; /api/getHeartbeat 500s on it.
    assert.equal(gateway.heartbeatState().ready, false);
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
    // READY is s:1; the mock's PRESENCE_UPDATE echo for the op-3 frame is s:3.
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

test("connectionState() reports the session lifecycle", async () => {
    const gateway = await connectReady();

    assert.deepEqual(gateway.connectionState(), { state: "connected", ready: true });

    // A gateway-side drop starts an automatic retry: the state is the backoff
    // gap, not "disconnected" (nothing about it needs the user's help).
    MockWebSocket.instances.at(-1).close(4009);
    await sleep(10); // let the close handler run and arm the backoff timer
    assert.deepEqual(gateway.connectionState(), { state: "reconnecting", ready: false });

    gateway.disconnect();
    assert.deepEqual(gateway.connectionState(), { state: "disconnected", ready: false },
        "a manual disconnect is its own state: nothing will reconnect");
});

test("disconnect() drops the resumable session state", async () => {
    const gateway = await connectReady();
    assert.equal(gateway.sessionId, "session-1");

    gateway.disconnect();

    // A session closed on purpose is not resumable, so the state a RESUME
    // would need is gone: the next connect has to identify fresh.
    assert.equal(gateway.sessionId, null);
    assert.equal(gateway.seq, null);
});

test("reconnect() after a manual disconnect identifies a fresh session", async () => {
    const gateway = await connectReady();
    const firstSocket = MockWebSocket.instances.at(-1);
    const instanceCount = MockWebSocket.instances.length;

    gateway.disconnect();
    const readyPromise = waitFor(gateway, "ready");
    await gateway.reconnect();
    await readyPromise;

    const socket = MockWebSocket.instances.at(-1);
    assert.equal(MockWebSocket.instances.length, instanceCount + 1, "exactly one new socket");
    assert.notEqual(socket, firstSocket);
    assert.ok(socket.sent.some((f) => f.op === 2), "IDENTIFY went out");
    assert.ok(!socket.sent.some((f) => f.op === 6), "no RESUME with a dead session id");
    assert.equal(gateway.ready, true);
    assert.equal(gateway.sessionId, "session-1", "the new session id is stored");
    assert.deepEqual(gateway.connectionState(), { state: "connected", ready: true });

    gateway.disconnect();
});

test("reconnect() while a backoff is pending keeps one socket in flight", async () => {
    // Long backoff so the scheduled retry is still pending when the user hits
    // Reconnect. Without the timer being cleared, that retry would fire later
    // and open a second socket for the same account.
    const gateway = await connectReady({ reconnectBaseDelayMs: 4000 });
    const instanceCount = MockWebSocket.instances.length;

    MockWebSocket.instances.at(-1).close(4009); // arms the 4000ms retry
    await sleep(10);
    assert.deepEqual(gateway.connectionState(), { state: "reconnecting", ready: false });

    const readyPromise = waitFor(gateway, "ready");
    await gateway.reconnect();
    await readyPromise;

    assert.equal(gateway._reconnectTimer, null, "pending backoff timer was cleared");
    assert.equal(MockWebSocket.instances.length, instanceCount + 1, "one socket, not two");
    assert.deepEqual(gateway.connectionState(), { state: "connected", ready: true });

    gateway.disconnect();
});

test("reconnect() restores backoff after a manual disconnect", async () => {
    // The deliberate disconnect must not leave the backoff state poisoned: a
    // socket drop right after reconnecting gets the base delay, not the
    // doubled one from before it went down.
    const gateway = await connectReady({ reconnectBaseDelayMs: 20 });
    MockWebSocket.instances.at(-1).close(4009);
    await sleep(30); // one automatic retry ran, doubling the delay to 40ms

    await gateway.reconnect();
    assert.equal(gateway._reconnectDelayMs, 20, "backoff reset to base");

    gateway.disconnect();
});

test("connect() refuses to open a second socket while one is live", async () => {
    const gateway = await connectReady();
    const instanceCount = MockWebSocket.instances.length;

    await assert.rejects(gateway.connect(), /already connected/);
    assert.equal(MockWebSocket.instances.length, instanceCount, "no extra socket");

    gateway.disconnect();
});

test("reconnect() while a session is live is a no-op", async () => {
    // Two tabs, a double press, a scripted call: opening a second session on
    // top of a live one would fight it for the presence, so it must not happen.
    const gateway = await connectReady();
    const instanceCount = MockWebSocket.instances.length;

    await gateway.reconnect();
    await sleep(50);

    assert.equal(MockWebSocket.instances.length, instanceCount, "no second socket");
    assert.deepEqual(gateway.connectionState(), { state: "connected", ready: true });
    assert.equal(gateway.sessionId, "session-1", "the live session is untouched");

    gateway.disconnect();
});

test("an auto-reconnect after a reconnect() reconnect on its own", async () => {
    // The UI's Reconnect must not take the class out of its auto-reconnect
    // role: the session it opens has to be guarded like any other.
    const gateway = await connectReady();
    gateway.disconnect();

    const readyPromise = waitFor(gateway, "ready");
    await gateway.reconnect();
    await readyPromise; // the new session must be live before it drops
    const firstSocket = MockWebSocket.instances.at(-1);

    const resumed = waitFor(gateway, "resumed");
    firstSocket.close(4009);
    await resumed;

    assert.deepEqual(gateway.connectionState(), { state: "connected", ready: true });
    assert.ok(MockWebSocket.instances.at(-1).sent.some((f) => f.op === 6),
        "the automatic path resumes as usual");

    gateway.disconnect();
});
