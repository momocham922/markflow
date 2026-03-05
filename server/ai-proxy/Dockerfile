FROM node:22-alpine

WORKDIR /app

RUN npm install firebase-admin

COPY index.ts index.ts

# Transpile TypeScript to JavaScript at build time
RUN npx -y esbuild index.ts --bundle --platform=node --outfile=server.js \
    --external:firebase-admin --external:@firebase --external:@google-cloud

EXPOSE 8080

CMD ["node", "server.js"]
