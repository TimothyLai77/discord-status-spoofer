import os
from dotenv import load_dotenv
import discord # specifically use the discord.py-self fork, since idk seems to work better?

# get discord user token from .env
load_dotenv()
token = os.getenv('TOKEN')


class MyClient(discord.Client):
    async def on_ready(self):
        print(f'Logged in as {self.user} (ID: {self.user.id})')
        print('------')
        await client.change_presence(status=discord.Status.dnd, afk=True)

client = MyClient()
client.run(token)