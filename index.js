FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Instala deps de producción
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copia la app
COPY . .

# Entorno
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=0

EXPOSE 8080

# Healthcheck para Railway (golpea /health local)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||3000) + '/health', r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node","index.js"]
