FROM node:22-alpine

WORKDIR /app

RUN npm install y-websocket ws

COPY index.ts index.ts

# Transpile TypeScript to JavaScript at build time
RUN npx -y esbuild index.ts --bundle --platform=node --outfile=server.js --external:ws --external:y-websocket

ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "server.js"]
