import { expect as playwrightExpect, test as base, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  IsolatedServer,
  type IsolatedServerOptions,
  launchIsolatedServer,
} from "./isolated-server.js";
import { NetworkFaultController } from "./network-faults.js";
import {
  attachFailureArtifacts,
  installBrowserErrorCollectors,
  type BrowserErrorCollector,
} from "./artifacts.js";

const artifactRoot = resolve(process.cwd(), "artifacts", "e2e");
const retryFailureRoot = join(artifactRoot, "retry-failures");

export type E2EWorkerFixtures = {
  serverOptions: IsolatedServerOptions;
};

export type E2ETestFixtures = {
  server: IsolatedServer;
  faultController: NetworkFaultController;
  baseURL: string;
  page: Page;
  failureArtifacts: void;
};

function artifactServer(server: IsolatedServer): Record<string, unknown> {
  return {
    dataDir: server.dataDir,
    transcriptDir: server.transcriptDir,
    internalOrigin: server.internalOrigin,
    targetOrigin: server.targetOrigin,
    baseURL: server.baseURL,
    port: server.port,
    proxyPort: server.proxyPort,
    pid: server.pid,
    serverLogs: server.logSummary(),
    fixtureTranscript: server.transcriptDir,
  };
}

function retryMarker(testInfo: TestInfo): string {
  const safeId = testInfo.testId.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return join(retryFailureRoot, `${safeId}.json`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function attachServerFailure(testInfo: TestInfo, server: IsolatedServer, faultController: NetworkFaultController, page: Page): Promise<void> {
  try {
    await attachFailureArtifacts(testInfo, {
      server: artifactServer(server),
      faultController,
      page,
      isolatedFixtureDir: server.dataDir,
    });
  } catch {
    // Artifact collection must never replace the test's original failure.
  }
}

export const test = base.extend<E2ETestFixtures, E2EWorkerFixtures>({
  serverOptions: [{}, { scope: "worker", option: true }],

  server: async ({ serverOptions }, use, testInfo) => {
    const options: IsolatedServerOptions = {
      ...serverOptions,
      workerIndex: testInfo.workerIndex,
      projectName: testInfo.project.name,
    };
    const server = await launchIsolatedServer(options);
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },

  faultController: async (
    { server }: { server: IsolatedServer },
    use: (controller: NetworkFaultController) => Promise<void>,
  ) => {
    const controller = server.faultController;
    if (!controller) throw new Error("isolated server has no network fault controller");
    await use(controller);
  },

  baseURL: async ({ server }, use) => {
    if (!server.baseURL) throw new Error("isolated server has no proxy base URL");
    await use(server.baseURL);
  },

  page: async ({ page }, use) => {
    const collector: BrowserErrorCollector = installBrowserErrorCollectors(page);
    try {
      await use(page);
    } finally {
      collector.dispose();
    }
  },

  failureArtifacts: [async ({ server, faultController, page }, use, testInfo) => {
    const marker = retryMarker(testInfo);
    await mkdir(retryFailureRoot, { recursive: true });
    if (testInfo.retry === 0) await rm(marker, { force: true });
    const previousAttemptFailed = testInfo.retry > 0 && await pathExists(marker);

    await use();

    const unexpectedFailure = testInfo.status !== testInfo.expectedStatus;
    if (unexpectedFailure) {
      await writeFile(marker, JSON.stringify({ testId: testInfo.testId, retry: testInfo.retry }), "utf8");
      await attachServerFailure(testInfo, server, faultController, page);
    } else if (previousAttemptFailed) {
      await attachServerFailure(testInfo, server, faultController, page);
      throw new Error("retry passed after an earlier attempt failed; the original failure is preserved");
    }
  }, { auto: true }],
});

export const expect = playwrightExpect;
export type { BrowserErrorCollector } from "./artifacts.js";
export { IsolatedServer } from "./isolated-server.js";
export type { IsolatedServerOptions, TranscriptEntry, TranscriptPredicate } from "./isolated-server.js";
