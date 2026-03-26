import type { Options } from "@wdio/types";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the Tauri app binary inside the Docker container
const tauriBinary = "/app/src-tauri/target/debug/markflow";

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./e2e-tauri/sync/**/*.test.ts"],
  exclude: [],

  // maxInstances must be 1 — tests coordinate between two instances sequentially
  maxInstances: 1,

  // Multiremote: control two Tauri app instances simultaneously
  capabilities: {
    // @ts-expect-error multiremote capabilities
    userA: {
      port: 4444,
      hostname: "localhost",
      capabilities: {
        // @ts-expect-error tauri custom capability
        "tauri:options": {
          application: tauriBinary,
        },
      },
    },
    // @ts-expect-error multiremote capabilities
    userB: {
      port: 4445,
      hostname: "localhost",
      capabilities: {
        // @ts-expect-error tauri custom capability
        "tauri:options": {
          application: tauriBinary,
        },
      },
    },
  },

  logLevel: "warn",
  bail: 0,

  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120000, // sync tests need longer timeout
  },

  reporters: ["spec"],
};
