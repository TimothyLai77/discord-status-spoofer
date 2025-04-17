# Discord Status Spoofer:
I want my Discord status to be set as one status and to not update.
This is a Python program (using discord.py-self) with a React frontend to pick a status. 

# Setup (docker):
1. copy the `env_template.txt` as `.env` and fill in the fields
2. `docker compose up -d` to run

# Setup (no docker):
1. `cd discord-spoofer-frontend` and `npm i`
2. `npm run build`
3. return to project root and `pip install -r requirements.txt`
  * I've had some problems getting this to work, but you'll need `flask[async] and `discord.py-self` (the discord library might have more sub dependencies you'll have to install)
4. `python3 main.py`



# Getting your Discord token
Discord very much doesn't like people doing this [see Discord](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots), so do it at your own risk.


From [Discord.js-selfbot](https://github.com/aiko-chan-ai/discord.js-selfbot-v13/tree/main) getting your own token:
```js
window.webpackChunkdiscord_app.push([
  [Math.random()],
  {},
  req => {
    if (!req.c) return;
    for (const m of Object.keys(req.c)
      .map(x => req.c[x].exports)
      .filter(x => x)) {
      if (m.default && m.default.getToken !== undefined) {
        return copy(m.default.getToken());
      }
      if (m.getToken !== undefined) {
        return copy(m.getToken());
      }
    }
  },
]);
console.log('%cWorked!', 'font-size: 50px');
console.log(`%cYou now have your token in the clipboard!`, 'font-size: 16px');
```
* probably best to go into an incog window, use that code snippet, and then CLOSE the browser window, logout revokes the token. 

# Other Notes:
There's probably some bugs in here, honestly I would rewrite the backend using node instead of python but now I just want a working program.
