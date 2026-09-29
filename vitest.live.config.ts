import { defineConfig } from "vitest/config";

/**
 * Live guards for the outside-records prompt rules.
 *
 * Kept out of `pnpm test` (see vite.config.ts) because these call the real
 * model and the real aggregator: they cost money and take minutes. Run them
 * when changing rule 10 or rule 11 in server/ai-proxy/refine.ts, which are the
 * only thing standing between a set of minutes and someone else's meeting.
 *
 *   pnpm test:live-context
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["server/ai-proxy/*.live-test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    // One live call at a time: these hit the same upstream quota.
    fileParallelism: false,
  },
});
