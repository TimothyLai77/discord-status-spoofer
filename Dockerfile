FROM node:23.11.0 AS build-stage
# app directory
WORKDIR /app
# copy the env file in
COPY . .
# ========= FRONTEND STUFF =========
# create dir
WORKDIR /app/discord-spoofer-frontend

# install depedencies
# COPY ./discord-spoofer-frontend/package*.json /app/discord-spoofer-frontend/

RUN npm install

RUN npm run build

# ========= BACKEND STUFF =========
FROM python:3.13 AS final-stage
COPY --from=build-stage /app/discord-spoofer-frontend/ /app/discord-spoofer-frontend/

COPY .env /app/.env
WORKDIR /app

#copy server code
COPY ./main.py ./main.py
COPY ./requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

#start the app
#CMD ["ls", "-la"]
CMD ["python", "main.py"]
