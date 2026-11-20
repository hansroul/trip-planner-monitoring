# Site de suivi PoppyTrip : image minimale, utilisateur non root, aucun secret dans l'image
# (toute la configuration arrive par les variables d'environnement de Railway).

FROM node:26.13.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json tsconfig.server.json tsconfig.client.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:26.13.1-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:26.13.1-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root sql/migrations ./sql/migrations
# Fichiers en lecture seule pour l'utilisateur d'exécution.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/server/index.js"]
