FROM node:24.3.0
# app directory
WORKDIR /discord-spoofer/
# copy everything (backend + static frontend)
COPY . .

RUN npm install

#start the app
CMD ["node", "index.js"]
