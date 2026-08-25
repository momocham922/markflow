FROM node:22-alpine

WORKDIR /app

RUN npm install firebase-admin stripe @apple/app-store-server-library google-auth-library

COPY index.ts index.ts
COPY gating.ts gating.ts
COPY metering.ts metering.ts
COPY billing.ts billing.ts
COPY iap.ts iap.ts
COPY apple-root-certs.ts apple-root-certs.ts
COPY feedback.ts feedback.ts
COPY telemetry.ts telemetry.ts

# Transpile TypeScript to JavaScript at build time (esbuild bundles the local
# ./gating, ./metering, ./billing, ./iap, ./apple-root-certs, ./feedback,
# ./telemetry imports into server.js; firebase-admin, the Google libs, the Stripe SDK, the Apple App Store
# Server library, and google-auth-library are resolved from node_modules at
# runtime — their top-level requires run at boot even while IAP is DARK).
RUN npx -y esbuild index.ts --bundle --platform=node --target=node20 --outfile=server.js \
    --external:firebase-admin --external:@firebase --external:@google-cloud \
    --external:stripe --external:@apple/app-store-server-library \
    --external:google-auth-library

EXPOSE 8080

CMD ["node", "server.js"]
