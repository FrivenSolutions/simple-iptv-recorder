FROM node:24-bookworm-slim

# ffmpeg only joins and remuxes (-c copy); it never transcodes. The font is for
# the spoiler-free title-card thumbnails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The commit this image was built from, shown on the Settings page.
ARG VERSION=dev
ENV NODE_ENV=production DATA_DIR=/config RECORDINGS_DIR=/recordings PORT=8089 APP_VERSION=$VERSION
EXPOSE 8089
HEALTHCHECK --interval=1m --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
