import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const E2E_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(E2E_DIRECTORY, "..");

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, received ${JSON.stringify(raw)}`);
  }
  return value;
}

function deviceScaleFactor(): number | undefined {
  const raw = process.env.TERM_SERVER_E2E_DPR;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`TERM_SERVER_E2E_DPR must be a finite positive number, received ${JSON.stringify(raw)}`);
  }
  return value;
}

function browserName(): "chromium" | "firefox" | "webkit" {
  const raw = process.env.TERM_SERVER_E2E_BROWSER ?? process.env.PLAYWRIGHT_BROWSER;
  if (raw === undefined || raw.trim() === "") return "chromium";
  if (raw === "chromium" || raw === "firefox" || raw === "webkit") return raw;
  throw new Error(`TERM_SERVER_E2E_BROWSER must be chromium, firefox, or webkit, received ${JSON.stringify(raw)}`);
}

const dpr = deviceScaleFactor() ?? 1;
const selectedBrowser = browserName();
const retries = positiveInteger("TERM_SERVER_E2E_RETRIES", process.env.TERM_SERVER_E2E_RETRIES, process.env.CI ? 1 : 0);
const workers = positiveInteger("TERM_SERVER_E2E_WORKERS", process.env.TERM_SERVER_E2E_WORKERS, 2);
if (workers === 0) throw new Error("TERM_SERVER_E2E_WORKERS must be at least 1");
const commonUse = {
  ...devices["Desktop Chrome"],
  baseURL: "http://127.0.0.1",
  trace: "retain-on-failure" as const,
  screenshot: "only-on-failure" as const,
  video: "retain-on-failure" as const,
  actionTimeout: 15_000,
  navigationTimeout: 30_000,
  deviceScaleFactor: dpr,
};

export default defineConfig({
  testDir: resolve(E2E_DIRECTORY, "specs"),
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries,
  workers,
  outputDir: resolve(REPOSITORY_ROOT, "artifacts", "e2e", "test-results"),
  reporter: [
    ["list"],
    ["html", { outputFolder: resolve(REPOSITORY_ROOT, "artifacts", "e2e", "report"), open: "never" }],
    ["json", { outputFile: resolve(REPOSITORY_ROOT, "artifacts", "e2e", "results.json") }],
  ],
  use: commonUse,
  projects: [
    {
      name: "chromium-pr",
      grep: /@p0|@pr|@smoke/,
      use: { ...commonUse, browserName: selectedBrowser },
    },
    {
      name: "chromium-packaged",
      grep: /@packaged/,
      use: { ...commonUse, browserName: selectedBrowser },
    },
    {
      name: "chromium-fallback",
      grep: /@fallback/,
      use: {
        ...commonUse,
        browserName: selectedBrowser === "chromium" ? "chromium" : selectedBrowser,
        launchOptions: {
          args: ["--disable-gpu", "--disable-gpu-compositing"],
        },
      },
    },
    {
      name: "chromium-nightly",
      grep: /@p0|@nightly/,
      use: { ...commonUse, browserName: selectedBrowser === "chromium" ? "chromium" : selectedBrowser },
    },
    {
      name: "firefox-nightly",
      grep: /@p0|@nightly/,
      use: { ...commonUse, browserName: selectedBrowser === "chromium" ? "firefox" : selectedBrowser },
    },
    {
      name: "webkit-nightly",
      grep: /@p0|@nightly/,
      use: { ...commonUse, browserName: selectedBrowser === "chromium" ? "webkit" : selectedBrowser },
    },
    {
      name: "soak",
      grep: /@soak/,
      timeout: 10 * 60_000,
      use: { ...commonUse, browserName: selectedBrowser },
    },
  ],
});
