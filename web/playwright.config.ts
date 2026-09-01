import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;
export default defineConfig({
  testDir: "./e2e", timeout: 30_000, retries: 0,
  use: { baseURL: "http://127.0.0.1:4320", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "npm run build && node web/e2e/fixture-server.mjs", cwd: fileURLToPath(new URL("..", import.meta.url)), url: "http://127.0.0.1:4320/health/ready", reuseExistingServer: false, timeout: 120_000 },
});
