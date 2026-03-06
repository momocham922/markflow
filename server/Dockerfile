FROM node:22-alpine

WORKDIR /app

RUN npm install ws yjs y-protocols lib0 firebase-admin

COPY index.ts index.ts

# Transpile TypeScript to JavaScript at build time
# External: ws (native), firebase-admin + its deps (too large to bundle)
RUN npx -y esbuild index.ts --bundle --platform=node --outfile=server.js \
    --external:ws --external:firebase-admin --external:firebase-admin/app --external:firebase-admin/auth --external:firebase-admin/firestore

EXPOSE 8080

CMD ["node", "server.js"]
