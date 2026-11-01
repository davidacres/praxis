/**
 * Imported first by `index.ts`, so it is in place before any other module loads.
 *
 * A test app (`PRAXIS_E2E=1`, set by the e2e suite's launcher) that hits an uncaught exception exits
 * instead of showing Electron's modal "Uncaught Exception" box. The suite may be running from a
 * workflow run's worktree on someone's desktop: in TASK-503 a worktree missing one package's build
 * output put an error box in front of the person's own work for every test app the stage launched.
 * Exiting also fails the test at once rather than at its window timeout.
 */
if (process.env.PRAXIS_E2E === '1') {
  process.on('uncaughtException', error => {
    console.error(`Uncaught exception in test app: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  });
}

export {};
