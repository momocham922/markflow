import type { Options } from "@wdio/types";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the Tauri app binary (Linux debug build)
const tauriBinary = path.resolve(
  __dirname,
  "src-tauri/target/debug/markflow"
);

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./e2e-tauri/**/*.test.ts"],
  exclude: [],

  maxInstances: 1,
  capabilities: [
    {
      // @ts-expect-error tauri custom capability
      "tauri:options": {
        application: tauriBinary,
        webviewOptions: {},
      },
    },
  ],

  logLevel: "warn",
  bail: 0,

  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  port: 4444,
  hostname: "localhost",

  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },

  reporters: ["spec"],
};
