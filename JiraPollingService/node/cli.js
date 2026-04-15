#!/usr/bin/env node

const path = require('node:path');
const { JiraPollingService, createConsoleLogger, loadPollingConfig } = require('./polling');

function readRequiredValue(argv, index, optionName) {
  const nextValue = argv[index + 1];
  if (!nextValue) {
    throw new Error(`${optionName} requires a value.`);
  }

  return nextValue;
}

function parseArgs(argv) {
  const args = {
    configPath: path.join(__dirname, '..', 'appsettings.json'),
    once: false,
    overrides: {}
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') {
      args.once = true;
      continue;
    }

    if (arg === '--config') {
      args.configPath = path.resolve(readRequiredValue(argv, index, '--config'));
      index += 1;
      continue;
    }

    if (arg === '--linked-epic') {
      args.overrides.LinkedEpicKey = readRequiredValue(argv, index, '--linked-epic').trim();
      index += 1;
      continue;
    }

    if (arg === '--required-label') {
      args.overrides.RequiredLabel = readRequiredValue(argv, index, '--required-label').trim();
      index += 1;
      continue;
    }

    if (arg === '--required-status') {
      args.overrides.RequiredStatus = readRequiredValue(argv, index, '--required-status').trim();
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function main() {
  const logger = createConsoleLogger();
  const args = parseArgs(process.argv.slice(2));
  const config = loadPollingConfig(args.configPath, args.overrides);
  const service = new JiraPollingService(config, { logger });
  const abortController = new AbortController();

  const shutdown = () => {
    abortController.abort();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await service.start({ once: args.once, signal: abortController.signal });
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

if (require.main === module) {
  main().catch(error => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };