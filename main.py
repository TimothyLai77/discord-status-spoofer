import os
from dotenv import load_dotenv
import discord

# get discord user token from .env
load_dotenv()
token = os.getenv('TOKEN')

client = discord.Client()

# see: https://discordpy-self.readthedocs.io/en/latest/api.html?highlight=status#discord.Status
# seems to be a bug: https://github.com/dolfies/discord.py-self/issues/740 with any other status apart from dnd
@client.event
async def on_ready():
    await client.change_presence(status=discord.Status.dnd, afk=True)
    print(f'We have logged in as {client.user}, with status as {client.client_status}')


client.run(token)
