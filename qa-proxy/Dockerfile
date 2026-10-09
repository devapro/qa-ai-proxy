FROM node:22-bookworm-slim

WORKDIR /opt/qa-proxy
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scenarios ./scenarios

RUN mkdir -p /var/lib/qa-proxy/ca && chown -R node:node /var/lib/qa-proxy
USER node

ENV QA_PROXY_PORT=8080 \
    QA_PROXY_CONTROL_PORT=8090 \
    QA_PROXY_CONTROL_HOST=0.0.0.0 \
    QA_PROXY_CA_DIR=/var/lib/qa-proxy/ca

EXPOSE 8080 8090
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
    CMD node -e "fetch('http://127.0.0.1:8090/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/index.js"]
