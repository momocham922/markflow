FROM node:22-alpine

WORKDIR /app

RUN npm install ws yjs y-protocols lib0

COPY index.ts index.ts

# Transpile TypeScript to JavaScript at build time
RUN npx -y esbuild index.ts --bundle --platform=node --outfile=server.js --external:ws

EXPOSE 8080

CMD ["node", "server.js"]
