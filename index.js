require('dotenv').config()

const express = require("express");
const cors = require("cors");
const path = require("path");
const CLIENT_FRONTEND_PATH = path.join(__dirname, "./", "discord-spoofer-frontend", "dist");
const PORT = process.env.PORT;

const { Client } = require('discord.js-selfbot-v13');
const app = express();


const prepareApp = async () => {
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use(cors());

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

    app.get('/api/status', async (req, res) => {
        console.log('GET: /api/status')
        try{
            const presence = client.user.presence;
            const status = presence.status;
            res.send(status);
        }catch{
            res.status(500);
            res.send('error getting user status')
        }

    });

    app.post('/api/updateStatus', async (req,res)=>{

    });



const TOKEN = process.env.TOKEN;
const client = new Client();
const changeStatus = (newStatus) => {
    // 'online', 'idle', 'dnd', 'invisible'
    client.user.setStatus(newStatus);
}

client.on('ready', async () => {
    console.log(`${client.user.username} is ready!`);
    changeStatus('idle');
})

client.login(TOKEN);


prepareApp();