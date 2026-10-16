# Pub quiz in a container. Build: docker build -t pubquiz .   Run: see compose.yaml or README.md.
FROM node:24-slim

# cloudflared (the internet link) checks Cloudflare's certificate against the system's trusted list.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# bun is only needed to build the single-file programs, not to run the server.
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY examples ./examples
COPY docker-entrypoint.sh ./

# Quizzes, saved games, results and the downloaded cloudflared live in /data, so mount a volume there.
ENV HOME=/data
# Writable by any user, so `docker run --user $(id -u):$(id -g)` works (on Linux, to keep your own files owned by you).
RUN mkdir -p /data && chown node:node /data && chmod 1777 /data
VOLUME /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
