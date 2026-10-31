FROM node:22-bookworm-slim

# ffmpeg for all media handling + fonts for sticker text rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp binary downloads itself during npm install (glibc image = right arch)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js menu.jpg cookies.txt config.json ./

# session + bridge queues live on volumes so they survive rebuilds
RUN mkdir -p auth_state bridge/inbox bridge/outbox

CMD ["node", "bot.js"]
