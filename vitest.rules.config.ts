import { defineConfig } from "vitest/config";

// Firestore SECURITY-RULES tests. These run in a Node environment against a live
// Firestore emulator (via @firebase/rules-unit-testing) and are therefore kept
// OUT of the default `pnpm test` glob (which is offline + jsdom). Run with:
//   pnpm test:rules
// which wraps this in `firebase emulators:exec` so the emulator is up first.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["firebase/**/*.rules.test.ts"],
    // The emulator can be cold on first connect; give the suite room.
    testTimeout: 20000,
    hookTimeout: 30000,
    // Rules tests share one emulator project namespace; run them serially so
    // clearFirestore() in one file never wipes another file's fixtures.
    fileParallelism: false,
  },
});
