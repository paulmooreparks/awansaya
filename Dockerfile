FROM node:20-alpine

RUN apk add --no-cache tini

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY www/ ./www/

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
