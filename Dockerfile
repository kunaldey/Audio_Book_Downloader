FROM node:20-slim

# Install Python, pip, ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp into a venv to avoid pip externally-managed error
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# YouTube breaks older yt-dlp releases regularly, so this layer must not be
# served from the build cache. Bump CACHE_BUST (or build with --no-cache) to
# force a fresh yt-dlp when downloads start failing:
#   docker compose build --build-arg CACHE_BUST=$(date +%s)
ARG CACHE_BUST=1
# yt-dlp-ejs ships the JS challenge solver locally, so yt-dlp does not need to
# fetch it from GitHub at runtime. Without it, YouTube's "n" challenge cannot be
# solved and media URLs come back throttled or 403 Forbidden.
RUN pip install --no-cache-dir --upgrade yt-dlp yt-dlp-ejs

# Make 'python' resolve to python3
RUN ln -s /opt/venv/bin/python /usr/local/bin/python

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app files
COPY server.js index.html download.py ./

ENV PORT=30333

EXPOSE 30333

CMD ["node", "server.js"]
