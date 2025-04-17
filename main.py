from flask import Flask, request, jsonify, render_template
from flask_cors import CORS, cross_origin
from waitress import serve
from dotenv import load_dotenv
import discord # specifically use the discord.py-self fork, since idk seems to work better?
import os
import asyncio
import threading
import json


# get discord user token from .env
load_dotenv('./.env',override=True)
token = os.getenv('TOKEN')
PORT = os.getenv('PORT')

statusDict ={
    "online": discord.Status.online,
    "away" : discord.Status.idle,
    "dnd" : discord.Status.dnd,
    "invisible" : discord.Status.invisible
}

async def changeStatus(status, isAFK=True):
    try:
        
        await client.change_presence(status=statusDict[status], afk=isAFK)
    except Exception as e:
        # right now it's throwing: MessageToDict() got an unexpected keyword argument 'including_default_value_fields'
        # seems to work if i just ignore it?
        #print(f'{e}')
        pass


# create flask app
app = Flask('flask-app',
            static_folder='./discord-spoofer-frontend/dist/static',
            template_folder='./discord-spoofer-frontend/dist'
            )
# f'http://127.0.0.1:{FRONTEND_PORT}', f'http://localhost:{FRONTEND_PORT}', i guess these aren't actually needed?
frontendOrigins = ['http://localhost']
CORS(app, resources={r"/api/*": {"origins": frontendOrigins}})


# function to start flask app
def startFlask():
    print(f'Starting webapp on port:{PORT} ')
    serve(app,host='0.0.0.0', port=PORT)
    #app.run(host='0.0.0.0', port=PORT)


class MyClient(discord.Client):
    async def on_ready(self):
        print(f'Logged in as {self.user}')
        await changeStatus(discord.Status.invisible)

    @app.route('/')
    def serveFrontend():
        return render_template("index.html")
    
    @app.route("/api/getStatus", methods=['GET'])
    @cross_origin()
    def getStatus():
        try:
            statusStr = client.status.value
            currentStatus = {
                "currentStatus": statusStr
                }
            return jsonify(currentStatus)
        except Exception as e:
            print(e)
            return "error", 500
        

    @app.route("/api/updateStatus", methods=['POST', 'OPTIONS'])
    async def changeStatusRequest():
        if request.method == 'OPTIONS':
            # Usually Flask-CORS handles OPTIONS requests automatically.
            return jsonify({}), 200
        # get json from post request
        # expected format: {"newStatus": "dnd", "isAfk": true}
        data = request.get_json()

        if not data:
            return jsonify({"error": "No JSON data provided"}), 400

        # try to update the status
        newStatus = data["newStatus"]
        afk = data["isAfk"]
        try:
            await changeStatus(newStatus, afk)
            return "success",200
        except Exception as e:
            return "error: could not update",500


client = MyClient()

def main():
    print('main starting..')

    flask_thread = threading.Thread(target=startFlask)
    flask_thread.start()
    asyncio.run(client.run(token))
    

if __name__ == "__main__":
    main()