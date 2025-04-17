FROM node:23.11.0
# app directory
WORKDIR /app
# copy the env file in
COPY ./env ./.env


# ========= FRONTEND STUFF =========

#install deps for backend
WORKDIR /app/discord-spoofer-frontend
RUN npm install --silent --no-optional

COPY ./discord-spoofer-frontend/package*.json ./

RUN npm install --silent --no-optional

# copy and build the react-ui
# so you can cache the ui build if changes are only made to server  
COPY ./discord-spoofer-frontend/src ./src
COPY ./discord-spoofer-frontend/public ./public
RUN npm run build

# ========= BACKEND STUFF =========
FROM python:3.13
WORKDIR /app
#copy server code
COPY ./main.py ./main.py
RUN pip install --no-cache-dir -r requirements.txt

#start the app
CMD ["python", "./main.py"]