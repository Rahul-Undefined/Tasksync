# TaskSync production image (used by the Render "Docker" web service).
# Stage 1 builds shared/, server/ and web/; stage 2 keeps only what the server needs to run.

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Install dependencies first so Docker can cache this layer between code changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production
# Render Free has 512 MB. With GitHub storage the live database is Node's built-in SQLite
# (~110 MB peak for the whole server). Keep it lean: fewer glibc malloc arenas and a capped heap.
ENV MALLOC_ARENA_MAX=2
ENV NODE_OPTIONS="--max-old-space-size=192 --disable-warning=ExperimentalWarning"
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/web/dist ./web/dist
# Run as the unprivileged "node" user that ships with the image.
USER node
# Render provides PORT (10000 by default); the server listens on it.
EXPOSE 10000
CMD ["node", "server/dist/index.js"]
