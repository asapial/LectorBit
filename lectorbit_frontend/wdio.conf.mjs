import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const executable = process.platform === 'win32' ? 'lectorbit.exe' : 'lectorbit';
const application = process.env.E2E_APP_BINARY
  ? path.resolve(process.env.E2E_APP_BINARY)
  : path.resolve(here, '../lectorbit_backend/target/debug', executable);

export const config = {
  runner: 'local',
  specs: ['./e2e/**/*.spec.mjs'],
  maxInstances: 1,
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  services: [
    [
      '@wdio/tauri-service',
      {
        driverProvider: 'embedded',
        embeddedPort: 4445,
        appBinaryPath: application,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        startTimeout: 120_000,
      },
    ],
  ],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': { application },
    },
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 60_000 },
};
