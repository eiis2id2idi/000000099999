FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data/storage/sites /app/data/storage/apis

EXPOSE 3000

CMD ["node", "server.js"]
