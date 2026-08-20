FROM node:22-alpine

WORKDIR /app

RUN npm install firebase-admin stripe

COPY index.ts index.ts
COPY gating.ts gating.ts
COPY metering.ts metering.ts
COPY billing.ts billing.ts
COPY iap.ts iap.ts

# Transpile TypeScript to JavaScript at build time (esbuild bundles the local
# ./gating, ./metering, ./billing imports into server.js; firebase-admin, the
# Google libs, and the Stripe SDK are resolved from node_modules at runtime).
RUN npx -y esbuild index.ts --bundle --platform=node --target=node20 --outfile=server.js \
    --external:firebase-admin --external:@firebase --external:@google-cloud \
    --external:stripe

EXPOSE 8080

CMD ["node", "server.js"]
