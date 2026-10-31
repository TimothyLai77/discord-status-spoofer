"use strict";

/**
 * Integration test for the Express API surface of index.js, with the
 * gateway module stubbed out (no network, no token needed).
 *
 * Run with:  node --test
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const PORT = 4317;

/**
 * Stand-in for DiscordGateway with the same surface index.js uses.
 */
class StubGateway extends EventEmitter {
    /** @type {StubGateway|null} Most recently constructed instance. */
    static instance = null;

    /** @param {{token: string}} options */
    constructor(options) {
        super();
        StubGateway.instance = this;
        this.token = options.token;
        this.ready = false;
        this.status = null;
        /** @type {Object|null} READY user object, like the real gateway stores. */
        this.user = null;
        /** Heartbeat state the real gateway keeps from HELLO / ACK frames. */
        this.intervalMs = 41250;
        this.lastAckMs = 0;
        /** Connection state the real gateway reports to /api/gateway/connection. */
        this.state = "connecting";
        /** @type {Array<[string, boolean]>} setPresence calls in order. */
        this.presenceCalls = [];
        /** When true, setPresence rejects like the real gateway does when
         *  the socket is not open. */
        this.rejectPresence = false;
        /** When true, reconnect() rejects like a failed socket handshake. */
        this.rejectReconnect = false;
        /** Number of disconnect()/reconnect() calls, for the routes to assert. */
        this.disconnectCalls = 0;
        this.reconnectCalls = 0;
    }

    /** @returns {Promise<void>} */
    connect() { return Promise.resolve(); }

    /**
     * Mirror of DiscordGateway#disconnect: drop the session, do not reconnect.
     * @returns {void}
     */
    disconnect() {
        this.disconnectCalls++;
        this.ready = false;
        this.state = "disconnected";
    }

    /**
     * Mirror of DiscordGateway#reconnect: a fresh identify. Resolves at
     * identify time (READY has not arrived yet), like the real one.
     * @returns {Promise<void>}
     */
    async reconnect() {
        if (this.state === "connected") {
            return; // the real reconnect() is a no-op while a session is live
        }
        if (this.rejectReconnect) {
            throw new Error("connect failed: network down");
        }
        this.reconnectCalls++;
        this.state = "connecting";
    }

    /** Mirror of DiscordGateway#connectionState (used by /api/gateway/connection). */
    connectionState() {
        if (this.state === "disconnected") {
            return { state: "disconnected", ready: false };
        }
        if (this.ready) {
            return { state: "connected", ready: true };
        }
        return { state: this.state, ready: false };
    }

    /**
     * @param {string} status
     * @param {boolean} [afk]
     * @returns {Promise<void>}
     */
    async setPresence(status, afk = false) {
        if (this.rejectPresence || !this.ready) {
            throw new Error("gateway is not connected");
        }
        this.presenceCalls.push([status, afk]);
        this.status = status;
    }

    /** Mirror of DiscordGateway#heartbeatState (used by /api/getHeartbeat). */
    heartbeatState() {
        return { intervalMs: this.intervalMs, lastAckMs: this.lastAckMs, ready: this.ready };
    }

    /** Test helper: pretend the gateway became ready. */
    becomeReady() {
        this.ready = true;
        this.state = "connected";
        // Real gateway seeds lastAckMs when IDENTIFY goes out (see #onHello).
        this.lastAckMs = Date.now();
        this.user = { id: "123456789012345678", username: "stubuser", global_name: "Stub User" };
        this.emit("ready", this.user);
    }
}

// Inject the stub into the require cache BEFORE index.js loads the real
// gateway module.
const gatewayPath = path.join(__dirname, "..", "lib", "discord-gateway.js");
const resolved = require.resolve(gatewayPath);
require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { DiscordGateway: StubGateway, OPCODE: {} },
};

process.env.PORT = String(PORT);
process.env.TOKEN = "stub-token";
require("../index.js");

const base = `http://127.0.0.1:${PORT}`;

/**
 * Wait until the express server accepts connections.
 * @returns {Promise<void>}
 */
async function waitServer() {
    for (let i = 0; i < 50; i++) {
        try {
            await fetch(`${base}/api/getStatus`);
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error("express server did not start");
}

test("getStatus returns 500 before the gateway is ready", async () => {
    await waitServer();
    const res = await fetch(`${base}/api/getStatus`);
    assert.equal(res.status, 500);
});

test("getUser returns 500 before the gateway is ready", async () => {
    const res = await fetch(`${base}/api/getUser`);
    assert.equal(res.status, 500);
});

test("getHeartbeat returns 500 before the gateway is ready", async () => {
    const res = await fetch(`${base}/api/getHeartbeat`);
    assert.equal(res.status, 500);
});

test("updateStatus returns 500 before the gateway is ready", async () => {
    const res = await fetch(`${base}/api/updateStatus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "idle" }),
    });
    assert.equal(res.status, 500);
});

test("after ready: default status is online+away (afk) and updateStatus changes it", async () => {
    StubGateway.instance.becomeReady();
    // Let the ready handler's changeStatus('online', true) microtask settle.
    await new Promise((r) => setTimeout(r, 50));

    // Regression: the startup default must mark the account away (afk:true).
    // That state is what makes Discord dispatch mobile push notifications,
    // and after a restart nothing re-arms it except a UI click — so
    // starting online+afk:false silently killed all pushes (PR #13).
    // No earlier test records a presence call, so at(0) is the ready call.
    assert.deepEqual(StubGateway.instance.presenceCalls.at(0), ["online", true]);

    let res = await fetch(`${base}/api/getStatus`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { currentStatus: "online" });

    res = await fetch(`${base}/api/updateStatus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "dnd" }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${base}/api/getStatus`);
    assert.deepEqual(await res.json(), { currentStatus: "dnd" });
    assert.deepEqual(StubGateway.instance.presenceCalls.at(-1), ["dnd", false]);
});

test("getUser returns the READY username after ready", async () => {
    const res = await fetch(`${base}/api/getUser`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { username: "stubuser" });
});

test("getHeartbeat reports the heartbeat interval and ack age", async () => {
    const res = await fetch(`${base}/api/getHeartbeat`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["ackAgoMs", "intervalMs", "serverNowMs"]);
    assert.equal(body.intervalMs, 41250);
    assert.ok(Number.isFinite(body.ackAgoMs) && body.ackAgoMs >= 0, `ackAgoMs: ${body.ackAgoMs}`);
    assert.ok(Number.isFinite(body.serverNowMs) && body.serverNowMs > 0);
    // Just acked at becomeReady, so the age must be tiny — a UI comparing
    // this against 2 * intervalMs reads "healthy" immediately.
    assert.ok(body.ackAgoMs < 5_000, `ackAgoMs: ${body.ackAgoMs}`);
});

test("getHeartbeat age keeps growing while no ack arrives", async () => {
    // The reconnect-gap case the UI shows as unhealthy: lastAckMs goes stale
    // and nothing resets it until the next session seeds it.
    StubGateway.instance.lastAckMs = Date.now() - 90_000;
    const res = await fetch(`${base}/api/getHeartbeat`);
    const body = await res.json();
    assert.ok(body.ackAgoMs >= 90_000, `ackAgoMs: ${body.ackAgoMs}`);
    assert.ok(body.ackAgoMs > 2 * body.intervalMs, "past the zombie-connection threshold");
    StubGateway.instance.lastAckMs = Date.now();
});

test("updateStatus passes isAfk through to setPresence", async () => {
    // Regression: the UI sends isAfk:true on every status change so the
    // account reads as away and mobile push notifications keep firing. The
    // handler must not drop the flag (it did, which silenced pushes).
    const res = await fetch(`${base}/api/updateStatus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "online", isAfk: true }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(StubGateway.instance.presenceCalls.at(-1), ["online", true]);
});

test("process survives the gateway emitting 'error' (reconnect failure)", async () => {
    // index.js must listen for 'error': without a listener the
    // EventEmitter throws and the process crashes on a failed reconnect.
    StubGateway.instance.emit("error", new Error("connect failed: network down"));
    // Give the event loop a tick; previously this killed the process.
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`${base}/api/getStatus`);
    assert.equal(res.status, 200); // stub still ready and serving
});

test("ready handler tolerates a rejected setPresence", async () => {
    const stub = StubGateway.instance;
    // Simulate the socket dying right after READY: setPresence rejects,
    // exactly like the real gateway when the socket is not open. Previously
    // that was an unhandled rejection that crashed the process.
    stub.rejectPresence = true;
    try {
        stub.emit("ready", { username: "stub" });
    } finally {
        stub.rejectPresence = false;
    }
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`${base}/api/getStatus`);
    assert.equal(res.status, 200);
});

test("gateway/connection reports the state while the session is starting", async () => {
    // Put the stub back into the state the app is in right after a process
    // start, before READY.
    const stub = StubGateway.instance;
    stub.ready = false;
    stub.state = "connecting";

    const res = await fetch(`${base}/api/gateway/connection`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "connecting", ready: false });

    // The session-data routes 500 in that state. The connection route must
    // not: it is what renders the Disconnect/Reconnect toggle, including in
    // the states where there is no session at all.
    assert.equal((await fetch(`${base}/api/getStatus`)).status, 500);
});

test("disconnect drops the session so status updates stop working", async () => {
    const stub = StubGateway.instance;
    stub.becomeReady();
    await new Promise((r) => setTimeout(r, 50));
    // Give the account a known status to lose.
    await fetch(`${base}/api/updateStatus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "dnd", isAfk: false }),
    });
    assert.equal((await fetch(`${base}/api/getStatus`)).status, 200);
    const disconnectsBefore = stub.disconnectCalls;

    const res = await fetch(`${base}/api/gateway/disconnect`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "disconnected", ready: false });
    assert.equal(stub.disconnectCalls, disconnectsBefore + 1);

    // No session: nothing to set, and nothing to report.
    const update = await fetch(`${base}/api/updateStatus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "idle" }),
    });
    assert.equal(update.status, 500);
    assert.equal((await fetch(`${base}/api/getStatus`)).status, 500);
});

test("connection stays disconnected after a manual disconnect", async () => {
    // The state the UI needs: "Disconnected" + a Reconnect button, read off
    // a 200 (a 500 here would paint "can't reach the server").
    const res = await fetch(`${base}/api/gateway/connection`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "disconnected", ready: false });
});

test("reconnect re-opens the session and restores the last status", async () => {
    const stub = StubGateway.instance;

    const res = await fetch(`${base}/api/gateway/reconnect`, { method: "POST" });
    assert.equal(res.status, 200);
    // The route resolves at identify time; READY has not landed yet, so the
    // UI shows "Connecting…" and polls from here.
    assert.deepEqual(await res.json(), { state: "connecting", ready: false });
    assert.equal(stub.reconnectCalls, 1);

    // READY lands a moment later. Regression: a fresh identify must restore
    // the status the user had (dnd above), not reset it to the startup
    // default online+away.
    stub.becomeReady();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(stub.presenceCalls.at(-1), ["dnd", false]);

    const status = await fetch(`${base}/api/getStatus`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { currentStatus: "dnd" });

    const state = await (await fetch(`${base}/api/gateway/connection`)).json();
    assert.deepEqual(state, { state: "connected", ready: true });
});

test("a failed reconnect 500s and leaves the gateway disconnected", async () => {
    const stub = StubGateway.instance;
    stub.disconnect();
    stub.rejectReconnect = true;
    try {
        const res = await fetch(`${base}/api/gateway/reconnect`, { method: "POST" });
        assert.equal(res.status, 500);
        assert.match(await res.text(), /reconnecting the gateway: connect failed/);
    } finally {
        stub.rejectReconnect = false;
    }

    // The route must not leave a "connecting" label that never resolves: a
    // failed handshake has no socket and nobody owns a retry, so the honest
    // state is "disconnected" with the Reconnect button back.
    const state = await (await fetch(`${base}/api/gateway/connection`)).json();
    assert.deepEqual(state, { state: "disconnected", ready: false });
});

test("reconnect while connected is a no-op and never drops the session", async () => {
    // Regression for the route's failure path: an "already connected" error
    // used to fall into the catch, which marked the gateway down — so two
    // tabs pressing Reconnect could disconnect a live session.
    const stub = StubGateway.instance;
    stub.becomeReady();
    await new Promise((r) => setTimeout(r, 50));
    const callsBefore = stub.reconnectCalls;

    const res = await fetch(`${base}/api/gateway/reconnect`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "connected", ready: true });
    assert.equal(stub.reconnectCalls, callsBefore, "no second identify");

    const state = await (await fetch(`${base}/api/gateway/connection`)).json();
    assert.deepEqual(state, { state: "connected", ready: true });
});

// index.js owns the express server for the whole process; end the test
// process explicitly, preserving any failure exit code.
after(() => {
    process.exit(process.exitCode ?? 0);
});
