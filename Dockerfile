# SimpleSeek Server — Docker
#
# Uses Node.js 24 and installs Pi coding agent globally.
# Pi's LLM provider config is mounted at runtime from the host's ~/.pi/ directory.
# Database lives in Turso cloud — no local DB needed.

FROM node:24

# Install Pi coding agent globally (needed for pi --mode rpc subprocess)
RUN npm install -g @earendil-works/pi-coding-agent

# Create app directory
WORKDIR /app

# Copy dependency manifests and install
COPY server/package*.json ./
RUN npm install

# Copy application source code
COPY server/src/ ./src/
COPY server/.env ./

# Pi reads its provider config from $HOME/.pi/
# We mount the host's ~/.pi/ at runtime via docker-compose
ENV PI_HOME=/root/.pi

EXPOSE 3001

CMD ["node", "src/index.js"]
