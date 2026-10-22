# Discord Status Spoofer:
I want my Discord status to be set as one status and to not update.
This is a Node/Express program with a small static frontend (plain
HTML/CSS/JS, no build step) to pick a status. It speaks the official Discord
Gateway protocol directly (`lib/discord-gateway.js`) using Node's built-in
WebSocket — no selfbot library involved.

![demo](/readme_resources/example.gif)

# Important: official clients take priority over this app

This app sets your status over the official Gateway protocol, and Discord
always *accepts* those updates. But the status that actually shows (to other
users and in the official clients) is decided by Discord's **session
priority**: an active official client session — especially the desktop app —
always outranks this app's gateway session.

In practice:

- **No official client running** — the status set here is your status. It is
  kept, and takes over the moment the last official client is closed.
- **An official client (desktop app) is open** — that client's status wins.
  Your change here is stored by Discord but not shown while the client runs.

This is not a bug in the app: Discord authenticates its official clients
beyond what a gateway session can replicate, and a session that identifies
as the desktop client still loses to a real one (verified October 2026,
see `scripts/diag-desktop-priority.js`). To pin a status, keep the official
clients closed.

# Setup (docker):
1. copy the `env_template.txt` as `.env` and fill in the fields
2. `docker compose up -d` to run

# Setup (no docker):
1. `npm i`
2. `node index.js` (set the `PORT` env var first, see `env_template.txt`)

# Testing
`npm test` runs the gateway protocol + API surface tests (no token or network
needed).




# Getting your Discord token ()
Discord very much doesn't like people doing this [see Discord](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots), so do it at your own risk. 

Login to Discord on a web browser, open your browser dev tools and go to the network tab. Go into a DM or a server text channel, find the `@me` request, or even `messages`. Go into the request header and there should be an authorization field, that's your instances' Discord token. 



* probably best to go into an incog window, use that code snippet, and then CLOSE the browser window, logout revokes the token. 

