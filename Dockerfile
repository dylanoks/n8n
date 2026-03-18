# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — Instagram Reel Generator API
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim

# Install ffmpeg and common fonts
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies
COPY package.json ./
RUN npm install --production

# Copy application code
COPY server.js ./

# Create output & temp directories
RUN mkdir -p outputs tmp

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
