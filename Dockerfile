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
RUN pip install --no-cache-dir yt-dlp

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
