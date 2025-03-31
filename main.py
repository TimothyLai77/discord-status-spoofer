import discord # specifically use the discord.py-self fork, since idk seems to work better?
import os
from dotenv import load_dotenv
import asyncio

# get discord user token from .env
load_dotenv()
token = os.getenv('TOKEN')


class MyClient(discord.Client):
    async def on_ready(self):
        print(f'Logged in as {self.user}')
        # await client.change_presence(status=discord.Status.dnd, afk=True)
        await changeStaus(discord.Status.dnd,True)


async def changeStaus(status, isAFK=True):
    await client.change_presence(status=status, afk=True)


async def login():
    client = MyClient()
    await client.login(token)
    await clinet.connect(reconnect=True)

def main():
    print('Starting..')
    asyncio.run(login())



if __name__ == "__main__":
    main()