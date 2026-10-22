FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev=false --no-package-lock
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
