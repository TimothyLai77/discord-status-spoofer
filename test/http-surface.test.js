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
        /** @type {Array<[string, boolean]>} setPresence calls in order. */
        this.presenceCalls = [];
        /** When true, setPresence rejects like the real gateway does when
         *  the socket is not open. */
        this.rejectPresence = false;
    }

    /** @returns {Promise<void>} */
    connect() { return Promise.resolve(); }

    /** @returns {void} */
    disconnect() { /* no-op */ }

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

    /** Test helper: pretend the gateway became ready. */
    becomeReady() {
        this.ready = true;
        this.emit("ready", { username: "stub" });
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

test("updateStatus returns 500 before the gateway is ready", async () => {
    const res = await fetch(`${base}/api/updateStatus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newStatus: "idle" }),
    });
    assert.equal(res.status, 500);
});

test("after ready: default status is online and updateStatus changes it", async () => {
    StubGateway.instance.becomeReady();
    // Let the ready handler's changeStatus('online') microtask settle.
    await new Promise((r) => setTimeout(r, 50));

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

// index.js owns the express server for the whole process; end the test
// process explicitly, preserving any failure exit code.
after(() => {
    process.exit(process.exitCode ?? 0);
});
