import discord # specifically use the discord.py-self fork, since idk seems to work better?
import os
from dotenv import load_dotenv
import asyncio

# get discord user token from .env
load_dotenv(override=True)
token = os.getenv('TOKEN')


class MyClient(discord.Client):
    async def on_ready(self):
        print(f'Logged in as {self.user}')
        # await client.change_presence(status=discord.Status.dnd, afk=True)
        await changeStatus(discord.Status.dnd,True)

client = MyClient()

async def changeStatus(status, isAFK=True):
    await client.change_presence(status=status, afk=True)


async def login():
    await client.login(token)
    await client.connect(reconnect=True)
    #client.run(token)


def main():
    print('Starting..')
    asyncio.run(login())


if __name__ == "__main__":
    main()