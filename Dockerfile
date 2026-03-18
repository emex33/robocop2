FROM node:20-slim AS frontend

WORKDIR /ui
COPY dashboard-ui/package.json dashboard-ui/package-lock.json ./
RUN npm ci
COPY dashboard-ui/ ./
RUN npm run build
# Vite outputs to ../src/dashboard/public/dist relative to /ui, so it lands at /src/dashboard/public/dist

FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .
COPY --from=frontend /src/dashboard/public/dist ./src/dashboard/public/dist

CMD ["node", "src/index.js"]
