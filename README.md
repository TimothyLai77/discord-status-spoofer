Discord very much doesn't like people doing this [see Discord](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots), so do it at your own risk.
But I don't like people knowing what my status is at all times, so this just spoofs the status to something you can pick. Very basic program.

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

After that place it into a '.env' at the root level and run. There's either a node.js one with Discord.js, or a python one. Originally started with the JS one but it would eat eat a ton of memory for some reason (100+MB), so I switched to 
python and it seems to be quite a bit better. 
