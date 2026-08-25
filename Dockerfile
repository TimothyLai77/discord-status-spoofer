FROM node:24.3.0
# app directory
WORKDIR /discord-spoofer/
# copy everything (backend + static frontend)
COPY . .

RUN npm install

# Run as the unprivileged user that ships with the official node image
# (uid=1000, gid=1000) instead of root. The app only reads its own files
# and listens on a port > 1024, so no root privileges are needed.
USER node

#start the app
CMD ["node", "index.js"]
