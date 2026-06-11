FROM node:16

WORKDIR /usr/app

COPY azerothcore-armory/package*.json ./
RUN npm install

COPY azerothcore-armory/ ./
RUN npm run build
CMD [ "npm", "start" ]
