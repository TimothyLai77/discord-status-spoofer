const { Client, Presence, ClientPresence } = require('discord.js-selfbot-v13');
require('dotenv').config()

const client = new Client();
const token = process.env.TOKEN;
client.on('ready', async () => {
    ClientPresence.status = 'dnd';
    // Set the client user's presence
    //client.user.setPresence({ activities: [{ name: 'a' }], status: 'dnd' });
    s = ClientPresence.status;
    console.log(`${client.user.username}'s status is being spoofed as ${s}`);
})

client.login(token);