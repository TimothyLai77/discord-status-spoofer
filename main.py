from flask import Flask
from dotenv import load_dotenv
import discord # specifically use the discord.py-self fork, since idk seems to work better?
import os
import asyncio
import threading
import json


# get discord user token from .env
load_dotenv(override=True)
token = os.getenv('TOKEN')
PORT = int(os.getenv('PORT'))

statusDict ={
    "online": discord.Status.online,
    "away" : discord.Status.away,
    "dnd" : discord.Status.dnd,
    "invisible" : discord.Status.invisible
}

async def changeStatus(status, isAFK=True):
    try:
        await client.change_presence(status=status, afk=True)
    except Exception as e:
        print(f'{e}')
        pass

app = Flask('flask-app')



class MyClient(discord.Client):
    async def on_ready(self):
        print(f'Logged in as {self.user}')
        await changeStatus(discord.Status.online)
        app.run()

    @app.route("/status", methods=['POST'])
    async def changeStatusRequest():
        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON data provided"}), 400

        await changeStatus(discord.Status.dnd)
        return jsonify({"received": data}), 200



    

        


client = MyClient()



def main():
    print('main starting..')
    asyncio.run(client.run(token))
    




if __name__ == "__main__":
    main()