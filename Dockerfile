FROM node:22-alpine
RUN apk add --no-cache iputils iproute2
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV HUB_DATA=/data HUB_PORT=80
VOLUME /data
CMD ["node", "src/index.js"]
