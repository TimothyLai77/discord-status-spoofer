# Plan: Replace `discord.js-selfbot-v13` with a native Gateway client

## Goal
Remove the unmaintained `discord.js-selfbot-v13` dependency by speaking the
official Discord Gateway protocol directly (the same protocol the official web
client uses to set your status). No new runtime dependencies: the Docker image
runs Node 24, which has a built-in global `WebSocket`.

## Background / constraints
- Discord has **no REST endpoint for presence**. Status can only be changed via
  Gateway opcode 4 (`Update Status`). Confirmed against the official API docs.
- The app currently uses only 3 things from the library (all in `index.js`):
  1. `client.user.presence.status` → read current status
  2. `client.user.setPresence({ status, afk })` → change status
  3. `ready` / `shardReady` events → initial connect + resume logic
- The frontend only talks to `/api/getStatus` and `/api/updateStatus`, so the
  Express surface must stay identical.

## Design

### New file: `lib/discord-gateway.js`
A small `DiscordGateway` class extending `EventEmitter`:

- `connect()`
  1. `GET https://discord.com/api/v10/gateway` → base ws URL
  2. Open `WebSocket` to `${url}?v=10&encoding=json`
  3. On `HELLO` (op 10): start heartbeat timer, send `IDENTIFY` (op 2) with
     token, `GUILD_PRESENCES` intent (bit 8), and initial presence
  4. On `READY` (op 0 dispatch): store `session_id` + user id, emit `ready`
- Heartbeat: op 1 every `heartbeat_interval`, last `seq` (null before any
  dispatch). Handle server-requested heartbeats (op 1) immediately. If no
  `HEARTBEAT ACK` (op 11) arrives within 2× the interval, force a reconnect.
- `setPresence(status, afk)` → send op 4
  `{"status": <s>, "afk": <a>, "since": null, "activities": []}`.
  Rejects if not connected. Resolves once the frame is sent.
- Status tracking: `this.status` is set optimistically by `setPresence` and
  reconciled from `PRESENCE_UPDATE` dispatches for our own user id.
- Reconnect: on `RECONNECT` (op 7), close (4000/4001/4002/4009/10xx) or
  zombie-detection, reconnect with exponential backoff (1s → 30s).
  If a `session_id` exists, send `RESUME` (op 6) with last `seq`; on
  `RESUMED` dispatch emit `resumed`. If no `RESUMED` within 30s, re-identify.
- Failure: close code 4004 (auth failed) or `INVALID SESSION` (op 9,
  `d === false`) → emit `fatal` (index.js exits, docker restarts cleanly).

### `index.js` (behavior-preserving rewire)
| Old (selfbot library)            | New (gateway client)             |
|----------------------------------|----------------------------------|
| `client.user.presence.status`    | `gateway.status`                 |
| `client.user.setPresence({...})` | `await gateway.setPresence(s,a)` |
| `client.on('ready')`             | `gateway.on('ready')`            |
| `client.on('shardReady')`        | `gateway.on('resumed')`          |
| `client.login(TOKEN)`            | `gateway.connect()`              |

`statusAlreadySet` / `lastStatus` / `lastAfk` and the resume-on-reconnect
behavior (restore last status, else `invisible`) stay exactly the same.

### Tests: `test/gateway.test.js`
`node:test` + a mock WebSocket implementing the protocol (HELLO → READY →
acks → PRESENCE_UPDATE, plus RESUME flow). Covers: identify payload,
heartbeat cadence, setPresence frame + status tracking, server presence
reconcile, resume with session_id, 4004 fatal. Runs with `node --test` —
no real token needed.

### Housekeeping
- `package.json`: drop `discord.js-selfbot-v13`; regenerate lockfile.
- `README.md`: correct the stale "Python / discord.py-self" description.

## Out of scope
- ToS status is unchanged: a personal token over the Gateway is still a
  self-bot (see README). This only removes the old library.
- Sharding (never used), compression, activity/emoji presence, afk push
  notifications.

## Commit cadence
1. Plan (this file)
2. Gateway core: connect / identify / heartbeat
3. Presence update + status tracking
4. Resume / reconnect / failure handling
5. Tests (mock WebSocket)
6. Rewire `index.js` + drop dependency
7. README touch-up
