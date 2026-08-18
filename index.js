require('dotenv').config()

const express = require("express");
const path = require("path");
const CLIENT_FRONTEND_PATH = path.join(__dirname, "./", "discord-spoofer-frontend", "dist");
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
// isAfk is a leftover from the python version, i don't think discord.js supports this?
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
 * @param {boolean} isAfk afk to decide if Discord should send a push notification to mobile
 */
const changeStatus = async (newStatus, isAfk = true) => {
    // 'online', 'idle', 'dnd', 'invisible'
    console.log(`Changing status to: ${newStatus}`)
    await gateway.setPresence(newStatus, isAfk)
    statusAlreadySet = true;
    lastStatus = newStatus;
    lastAfk = isAfk;
}

gateway.on('ready', (user) => {
    console.log(`${user.username} is ready!`);
    changeStatus('online', true); // just default status as online
})

// fires when the session is resumed after a reconnect. restore the last
// status we set, or default to invisible if we never set one.
gateway.on('resumed', () => {
    if (statusAlreadySet) {
        console.log(`resuming ${lastStatus}`)
        changeStatus(lastStatus, lastAfk)
    } else {
        changeStatus('invisible', true); // default as invisible when resuming
    }
})

// auth failure (bad token): log and exit so the container restarts cleanly.
gateway.on('fatal', (err) => {
    console.error('fatal gateway error:', err.message);
    process.exit(1);
})

gateway.connect().catch((err) => {
    console.error('gateway connect failed:', err.message);
    process.exit(1);
});


prepareApp();
