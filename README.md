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

# HTTP API
The frontend (and anything else on your LAN) talks to Express on `PORT`:

| Route | Response |
| --- | --- |
| `GET /api/getStatus` | `{ currentStatus }` |
| `GET /api/getUser` | `{ username }` |
| `GET /api/getHeartbeat` | `{ intervalMs, ackAgoMs, serverNowMs }` |
| `POST /api/updateStatus` | `200`, body `{ newStatus, isAfk }` |
| `GET /api/gateway/connection` | `{ state, ready }` |
| `POST /api/gateway/disconnect` | `{ state, ready }` |
| `POST /api/gateway/reconnect` | `{ state, ready }` |

The first four return 500 while the gateway has not reached READY, which is
normal for a few seconds after a container start. The three gateway-control
routes answer in every state (a 500 there would make a deliberate
disconnect look like a dead server). The token never reaches the browser.

`getHeartbeat` is the "is it still working" check the UI shows in the card
footer. Discord sends a `HELLO` with the heartbeat interval (~41s) and the
gateway acks every heartbeat; `ackAgoMs` is how long it has been since the
last ack. The UI reads green under `2 * intervalMs` — the same threshold the
gateway uses to decide a connection is a zombie and force a reconnect — amber
above it, and red when the server cannot be reached. `serverNowMs` is the
server's clock at the moment of the response, so the UI can age `ackAgoMs` by
a second between polls without trusting the browser clock.




# Connecting the gateway down and back up

The card has a **Gateway** row with a state word (Connected / Connecting… /
Reconnecting… / Disconnected) and one toggle button: **Disconnect** while a
session is up, **Reconnect** once you have taken it down.

- **Disconnect** closes the websocket and stops the reconnect machinery. The
  app stays down until you press Reconnect — this is the only state where it
  refuses to reconnect, network drops included. While you are down the status
  buttons are greyed out and the status label reads `disconnected` (there is
  no socket to send a presence on), and the heartbeat line reads
  `heartbeats stopped` in neutral grey.
- **Reconnect** opens a **fresh session** (a new IDENTIFY, not a RESUME — a
  session Discord saw you close on purpose is not resumable). The button
  returns as soon as the identify is out, the row reads `Connecting…`, and the
  UI's 5s poll flips it to `Connected` when READY lands. Your **last status is
  restored**, not reset to the online+away startup default: pressing Reconnect
  asks for the connection back, not for your status to be re-picked. A forced
  re-identify (op 9, close 4007/4008) restores it the same way.
- A failed Reconnect (no network, socket dies before the session starts)
  answers 500 with the reason and leaves the state at `Disconnected` with the
  button ready to try again, rather than sitting on a `Connecting…` that never
  resolves.

Nothing here changes the automatic path: a socket that dies on its own keeps
resuming and reconnecting with backoff exactly as before.


# Getting your Discord token ()
Discord very much doesn't like people doing this [see Discord](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots), so do it at your own risk. 

Login to Discord on a web browser, open your browser dev tools and go to the network tab. Go into a DM or a server text channel, find the `@me` request, or even `messages`. Go into the request header and there should be an authorization field, that's your instances' Discord token. 



* probably best to go into an incog window, use that code snippet, and then CLOSE the browser window, logout revokes the token. 

