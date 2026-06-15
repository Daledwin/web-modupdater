# JDK 21 base (needed for "build from source" / gradlew), plus Node + git + ssh.
FROM eclipse-temurin:21-jdk-jammy

# System deps: git + ssh client for the deploy-key push, Node 20 for the server.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git openssh-client ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Zero runtime dependencies — just copy the source.
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WORK_DIR=/data \
    MODPACK_CLONE_DIR=/data/modpack-clone \
    GRADLE_USER_HOME=/data/.gradle

# /data holds the local clone, build scratch, gradle cache, and the normalized key.
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787

# Runs as root by default so it can read a host-owned 0600 deploy key bind-mount
# and write /data. This is a LOCAL tool bound to localhost — see README security notes.
CMD ["node", "src/server.js"]
