FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/var/data

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public

RUN mkdir -p /var/data && chown -R node:node /var/data
USER node

EXPOSE 3000
VOLUME ["/var/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
