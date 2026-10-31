FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY node ./node
RUN node node/build.mjs

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app/node/dist ./dist
USER node
ENV PORT=8080 ULS_LISTEN_HOST=0.0.0.0
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.mjs"]
