FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
