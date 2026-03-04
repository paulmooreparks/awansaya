FROM node:20-alpine

RUN apk add --no-cache tini

WORKDIR /app

COPY server.js ./
COPY www/ ./www/

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
