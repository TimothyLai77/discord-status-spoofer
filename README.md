Discord very much doesn't like people doing this, so do it at your own risk.
But I don't like people knowing what my status is at all time, so this just spoofs the status to something you can pick. Very basic program.

Uses the discord self bot from : https://github.com/aiko-chan-ai/discord.js-selfbot-v13/tree/main

also from their repo, getting your own token:
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

After that place it into a '.env' at the root level and run.