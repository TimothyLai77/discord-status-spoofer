
import discord # specifically use the discord.py-self fork, since idk seems to work better?
from discord.ext import tasks
import os
import asyncio
import threading
from dotenv import load_dotenv




# get discord user token from .env
load_dotenv(override=True)
token = os.getenv('TOKEN')
PORT = int(os.getenv('PORT'))

async def changeStatus(status, isAFK=True):
    try:
        await client.change_presence(status=status, afk=True)
    except Exception as e:
        print(f'{e}')
        pass


class MyClient(discord.Client):

    async def on_ready(self):
        print(f'Logged in as {self.user}')
        await changeStatus(discord.Status.idle)
        print('does this actually return now')
        


client = MyClient()



def main():

    print('main starting..')
    asyncio.run(client.run(token))




if __name__ == "__main__":
    main()