FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY db.js server.js xlsx.js ./
COPY public ./public
COPY ops ./ops

RUN mkdir -p /app/data /app/backups && chown -R node:node /app

USER node

EXPOSE 4173
VOLUME ["/app/data", "/app/backups"]

CMD ["node", "server.js"]
