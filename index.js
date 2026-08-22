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

// update the status {newStatus: "status", isAfk: bool}
// isAfk maps to the afk field of the op 4 presence frame. It is a leftover
// from the python version and is always false now (matches the official
// client); the UI's isAfk flag is accepted but intentionally ignored.
app.post('/api/updateStatus', async (req, res) => {
    try {
        // {newStatus: status, isAfk: true}
        console.log("POST: /api/updateStatus")
        const payload = req.body;
        const status = payload.newStatus;
        // TODO: set the status here to resume from on internet outage
        await changeStatus(status);
        res.send(`changed status to ${status}`, 200);
    } catch {
        res.status(500);
        res.send('error')
    }
});


/**
 * change status
 * @param {string} newStatus 'online', 'idle', 'dnd', 'invisible'
 * @param {boolean} [isAfk] the afk field of the op 4 frame; keep false,
 *   matching the official client (afk:true is a leftover that does nothing
 *   useful for this app)
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
    // .catch: if the socket dies between READY and here, setPresence
    // rejects — an unhandled rejection would crash the process.
    changeStatus('online').catch((err) => { // just default status as online
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
