require('dotenv').config()

const express = require("express");
const path = require("path");
// The frontend is plain HTML/CSS/JS (no build step), served straight from
// this directory.
const CLIENT_FRONTEND_PATH = path.join(__dirname, "discord-spoofer-frontend");
const PORT = process.env.PORT;


const app = express();
app.use(express.json());

const { DiscordGateway } = require('./lib/discord-gateway');
const TOKEN = process.env.TOKEN;
const gateway = new DiscordGateway({ token: TOKEN });

var statusAlreadySet = false;
var lastStatus = null;
var lastAfk = null;

const prepareApp = async () => {
    app.set("trust proxy", 1);
    // load the front ened
    app.use(express.static(CLIENT_FRONTEND_PATH));

    // express 5? updated some internal packages and it breaks using the '*' as a path
    // have to use this regex instead?
    // https://github.com/expressjs/express/issues/5936#issuecomment-2340677058
    app.get(/(.*)/, (req, res) => {
        res.sendFile(path.join(CLIENT_FRONTEND_PATH, 'index.html'));
    });

    app.listen(PORT, () => {
        console.log(`express started on port: ${PORT}`);
    })
}

// GET current status that the account has at the moment
app.get('/api/getStatus', async (req, res) => {
    console.log('GET: /api/status')
    try {
        if (!gateway.ready) {
            throw new Error('gateway not ready');
        }
        res.json({
            currentStatus: gateway.status
        })
    } catch {
        res.status(500);
        res.send('error getting user status')
    }

});

// GET the account this token belongs to. The name comes from the READY
// payload the gateway stores on gateway.user; before READY arrives there is
// nothing to report, so this 500s exactly like getStatus does.
app.get('/api/getUser', async (req, res) => {
    console.log('GET: /api/getUser')
    try {
        if (!gateway.ready || !gateway.user) {
            throw new Error('gateway not ready');
        }
        res.json({
            username: gateway.user.username
        })
    } catch {
        res.status(500);
        res.send('error getting user name')
    }

});

// GET heartbeat liveness, so the UI can show that the gateway connection is
// actually alive. Ages are computed here (server clock) and shipped with
// serverNowMs, so the browser can tick them up between polls without
// depending on its own clock matching ours.
app.get('/api/getHeartbeat', async (req, res) => {
    console.log('GET: /api/getHeartbeat')
    try {
        const { intervalMs, lastAckMs, ready } = gateway.heartbeatState();
        if (!ready) {
            throw new Error('gateway not ready');
        }
        const nowMs = Date.now();
        res.json({
            intervalMs,
            // Never negative: lastAckMs is seeded at session start, so in a
            // healthy session it is always <= now.
            ackAgoMs: Math.max(0, nowMs - lastAckMs),
            serverNowMs: nowMs
        })
    } catch {
        res.status(500);
        res.send('error getting heartbeat state')
    }

});

// ─── Gateway connection control ────────────────────────────────────────
// These three routes drive the UI's Disconnect/Reconnect toggle. Unlike the
// routes above, which report session data and therefore 500 with no session,
// /api/gateway/connection answers in every state — including "disconnected",
// which is exactly the state the UI needs to be able to render.

// GET connection state: { state: connected|connecting|reconnecting|disconnected, ready }
app.get('/api/gateway/connection', async (req, res) => {
    console.log('GET: /api/gateway/connection')
    res.json(gateway.connectionState());
});

// Drop the gateway connection and keep it down. disconnect() clears the
// heartbeat and reconnect timers, so nothing brings the socket back until
// the UI asks for it — the status buttons are greyed out in the UI for
// exactly that reason (setPresence has no socket to send on).
app.post('/api/gateway/disconnect', async (req, res) => {
    try {
        console.log('POST: /api/gateway/disconnect')
        gateway.disconnect();
        res.json(gateway.connectionState());
    } catch {
        res.status(500);
        res.send('error disconnecting the gateway')
    }
});

// Reconnect on user request, as a fresh identify (the session id left over
// from a deliberate disconnect is not resumable). This resolves once IDENTIFY
// has been sent — socket open and HELLO seen — which is the fast part; READY
// arrives a moment later. So the response says "connecting" and the UI polls
// /api/gateway/connection until it flips to "connected". A rejected connect()
// is a real handshake failure (no network, socket died before the session
// started) and is reported as a 500 with the reason. Pressing it when a
// session is already up is a no-op — it answers with the current state, so two
// tabs hitting Reconnect cannot identify over a live session.
app.post('/api/gateway/reconnect', async (req, res) => {
    try {
        console.log('POST: /api/gateway/reconnect')
        await gateway.reconnect();
        res.json(gateway.connectionState());
    } catch (err) {
        // A failed handshake leaves no socket and no retry scheduled — this is
        // a user-initiated connect, so nobody owns the retry. Mark the gateway
        // deliberately down so the UI offers "Reconnect" again instead of
        // sitting on a "connecting" label that never resolves.
        gateway.disconnect();
        res.status(500);
        res.send(`error reconnecting the gateway: ${err.message}`)
    }
});

// update the status {newStatus: "status", isAfk: bool}
// isAfk maps to the afk field of the op 3 presence frame. Discord uses it
// to decide whether the account is "away": with afk:true the mobile app
// resumes push notifications even while the account stays online. The UI
// sends isAfk:true on every change for exactly that reason.
app.post('/api/updateStatus', async (req, res) => {
    try {
        // {newStatus: status, isAfk: true}
        console.log("POST: /api/updateStatus")
        const payload = req.body;
        const status = payload.newStatus;
        const isAfk = payload.isAfk === true;
        // TODO: set the status here to resume from on internet outage
        await changeStatus(status, isAfk);
        res.send(`changed status to ${status}`, 200);
    } catch {
        res.status(500);
        res.send('error')
    }
});


/**
 * change status
 * @param {string} newStatus 'online', 'idle', 'dnd', 'invisible'
 * @param {boolean} [isAfk] the afk field of the op 3 frame. true marks the
 *   account away — the state that makes the mobile app send push
 *   notifications (the official client sends the same frame when away).
 */
const changeStatus = async (newStatus, isAfk = false) => {
    // 'online', 'idle', 'dnd', 'invisible'
    console.log(`Changing status to: ${newStatus}`)
    await gateway.setPresence(newStatus, isAfk)
    statusAlreadySet = true;
    lastStatus = newStatus;
    lastAfk = isAfk;
}

gateway.on('ready', (user) => {
    console.log(`${user.username} is ready!`);
    // First READY after a process start: default to online AND away (afk:true).
    // The op 3 docs say afk is "used to determine whether to dispatch mobile
    // push notifications", and nothing else re-arms the away state after a
    // start except a UI click (which also sends isAfk:true). Starting
    // online+afk:false silently killed pushes until someone opened the UI (PR #13).
    //
    // A later READY — a fresh identify, e.g. the UI's Reconnect button —
    // restores the last status we set instead of resetting to online+away.
    // The UI asks for a reconnect, it does not ask for its status to be reset,
    // and an op 9/4007 forced re-identify should not wipe the choice either.
    //
    // .catch: if the socket dies between READY and here, setPresence
    // rejects — an unhandled rejection would crash the process.
    const apply = statusAlreadySet
        ? changeStatus(lastStatus, lastAfk)
        : changeStatus('online', true); // default: online + away
    apply.catch((err) => {
        console.error('failed to set default status:', err.message);
    })
})

// fires when the session is resumed after a reconnect. restore the last
// status we set, or default to invisible if we never set one.
gateway.on('resumed', () => {
    const restore = statusAlreadySet
        ? changeStatus(lastStatus, lastAfk)
        : changeStatus('invisible'); // default as invisible when resuming
    if (statusAlreadySet) {
        console.log(`resuming ${lastStatus}`)
    }
    restore.catch((err) => {
        console.error('failed to restore status after resume:', err.message);
    })
})

// auth failure (bad token): log and exit so the container restarts cleanly.
gateway.on('fatal', (err) => {
    console.error('fatal gateway error:', err.message);
    process.exit(1);
})

// a failed reconnect attempt (e.g. a network blip) surfaces here. This
// listener is REQUIRED: an unhandled 'error' event on an EventEmitter
// throws and would crash the process mid-reconnect.
gateway.on('error', (err) => {
    console.error('gateway error (will keep retrying):', err.message);
})

// diagnostics: why the socket dropped and the reconnect backoff schedule.
// The close codes + reasons are the key to diagnosing session dropouts.
gateway.on('close', (code, reason) => {
    console.log(`gateway socket closed (code ${code}${reason ? ` reason: ${reason}` : ""})`);
})

gateway.on('reconnecting', ({ reason, delayMs }) => {
    console.log(`gateway reconnecting in ${delayMs}ms: ${reason}`)
})

// surface any other unhandled failure with context instead of a bare crash.
process.on('unhandledRejection', (err) => {
    console.error('unhandled promise rejection:', err)
    process.exit(1)
})

gateway.connect().catch((err) => {
    console.error('gateway connect failed:', err.message);
    process.exit(1);
});


prepareApp();
