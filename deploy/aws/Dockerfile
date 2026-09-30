FROM node:22-bookworm-slim
ENV NODE_ENV=production RELAY_HOST=0.0.0.0 RELAY_PORT=8788 RELAY_DATA_DIR=/var/lib/relay
WORKDIR /app
# The web UI is built before packaging, keeping npm and build tools off EC2.
COPY package.json ./
COPY standalone/*.mjs ./standalone/
COPY lib/relay/*.mjs ./lib/relay/
COPY standalone-dist/ ./standalone-dist/
COPY START-PROVIDER.cmd ./
COPY provider/*.py provider/update-config.json provider/version.json ./provider/
RUN mkdir -p /var/lib/relay && chown node:node /var/lib/relay
USER node
EXPOSE 8788
CMD ["node", "standalone/server.mjs"]
