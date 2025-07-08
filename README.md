# Discord Status Spoofer:
I want my Discord status to be set as one status and to not update.
This is a Python program (using discord.py-self) with a React frontend to pick a status. 

![demo](/readme_resources/example.gif)

# Setup (docker):
1. copy the `env_template.txt` as `.env` and fill in the fields
2. `docker compose up -d` to run

# Setup (no docker):
1. `npm i`
2. `cd discord-spoofer-frontend` and `npm i`
3. `npm run build`
4. return to project root and `node index.js`




# Getting your Discord token ()
Discord very much doesn't like people doing this [see Discord](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots), so do it at your own risk. 

Login to Discord on a web browser, open your browser dev tools and go to the network tab. Go into a DM or a server text channel, find the `@me` request, or even `messages`. Go into the request header and there should be an authorization field, that's your instances' Discord token. 



* probably best to go into an incog window, use that code snippet, and then CLOSE the browser window, logout revokes the token. 

