import discord # specifically use the discord.py-self fork, since idk seems to work better?
import os
import asyncio
import threading
from dotenv import load_dotenv
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn



# get discord user token from .env
load_dotenv(override=True)
token = os.getenv('TOKEN')
PORT = int(os.getenv('PORT'))

async def changeStatus(status, isAFK=True):
    await client.change_presence(status=status, afk=True)


class MyClient(discord.Client):
    async def on_ready(self):
        print(f'Logged in as {self.user}')
        # await client.change_presence(status=discord.Status.dnd, afk=True)
        await changeStatus(discord.Status.dnd,True)


class RequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'Hello world\t' + threading.currentThread().getName().encode() + b'\t' + str(threading.active_count()).encode() + b'\n')

# threaded example:  https://stackoverflow.com/a/51559006
class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle requests in a separate thread."""
    pass

client = MyClient()




async def login():
    # honestly i think i could swap this out for client.run instead
    await client.login(token)
    await client.connect(reconnect=True)


def startHTTPServer():
    httpd = ThreadedHTTPServer(('', PORT), RequestHandler)
    print('http server starting..')
    httpd.serve_forever()




def main():
    print('main starting..')
    asyncio.run(login())
    startHTTPServer()


if __name__ == "__main__":
    main()