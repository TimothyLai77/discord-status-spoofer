FROM node:24.3.0
# app directory
WORKDIR /discord-spoofer/
# copy everythign in 
COPY . .
# ========= FRONTEND STUFF =========
# create frontend
COPY discord-spoofer-frontend/ /discord-spoofer/discord-spoofer-frontend/
WORKDIR /discord-spoofer/discord-spoofer-frontend/

RUN npm install
RUN npm run build

# ========= BACKEND STUFF =========
WORKDIR /discord-spoofer

RUN npm install

#start the app
CMD ["node", "index.js"]






