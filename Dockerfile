# Pub quiz in a container. Build: docker build -t pubquiz .   Run: see compose.yaml or README.md.

# Stage 1: install the server's packages.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: none of the dependencies needs one, and a future compromised package could not run code at build time.
RUN npm ci --omit=dev --ignore-scripts

# Stage 2: the image that runs.
FROM node:24-slim

# cloudflared (the internet link) checks Cloudflare's certificate against the system's trusted list.
# The upgrade applies Debian's security fixes at build time: the node image can lag behind them by days, and the
# image scanner fails the build on a known, fixed vulnerability. (hadolint discourages upgrade in general, DL3005;
# here it is the point.) Pinning the certificate package's version would only break builds when it is superseded (DL3008).
# hadolint ignore=DL3005,DL3008
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The server runs on node alone. Taking npm out removes it, and the packages it bundles, from what ships.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
COPY public ./public
COPY examples ./examples
COPY docker-entrypoint.sh ./

# Quizzes, saved games, results and the downloaded cloudflared live in /data, so mount a volume there.
ENV HOME=/data
# Writable by any user, so `docker run --user $(id -u):$(id -g)` works (on Linux, to keep your own files owned by you).
RUN mkdir -p /data && chown node:node /data && chmod 1777 /data
VOLUME /data
# The node image's own user; compose and docker run can still override it with a numeric --user.
# hadolint ignore=DL3066
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
