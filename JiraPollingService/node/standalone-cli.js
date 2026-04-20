#!/usr/bin/env node

const path = require('node:path');
const { createConsoleLogger } = require('./polling');
const { loadStandaloneConfig, StandaloneJiraMrPollingService } = require('./standalone');

function readRequiredValue(argv, index, optionName) {
  const nextValue = argv[index + 1];
  if (!nextValue) {
    throw new Error(`${optionName} requires a value.`);
  }

  return nextValue;
}

function parseArgs(argv) {
  const args = {
    configPath: path.join(__dirname, '..', 'standalone-appsettings.json'),
    once: false,
    overrides: {
      TrackedIssueKeys: []
    }
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

    if (arg === '--issue-key') {
      args.overrides.TrackedIssueKeys.push(readRequiredValue(argv, index, '--issue-key').trim());
      index += 1;
      continue;
    }

    if (arg === '--repo-path') {
      args.overrides.RepoPath = path.resolve(readRequiredValue(argv, index, '--repo-path'));
      index += 1;
      continue;
    }

    if (arg === '--state-path') {
      args.overrides.StateFilePath = path.resolve(readRequiredValue(argv, index, '--state-path'));
      index += 1;
      continue;
    }

    if (arg === '--gitlab-url') {
      args.overrides.GitLabUrl = readRequiredValue(argv, index, '--gitlab-url').trim();
      index += 1;
      continue;
    }

    if (arg === '--gitlab-project') {
      args.overrides.GitLabProject = readRequiredValue(argv, index, '--gitlab-project').trim();
      index += 1;
      continue;
    }

    if (arg === '--mode') {
      args.overrides.Mode = readRequiredValue(argv, index, '--mode').trim();
      index += 1;
      continue;
    }

    if (arg === '--poll-interval') {
      args.overrides.PollIntervalSeconds = Number.parseInt(readRequiredValue(argv, index, '--poll-interval'), 10);
      index += 1;
      continue;
    }

    if (arg === '--executor-command') {
      args.overrides.ExecutorCommand = readRequiredValue(argv, index, '--executor-command');
      index += 1;
      continue;
    }

    if (arg === '--publish-command') {
      args.overrides.PublishCommand = readRequiredValue(argv, index, '--publish-command');
      index += 1;
      continue;
    }

    if (arg === '--artifact-pattern') {
      args.overrides.ArtifactPattern = readRequiredValue(argv, index, '--artifact-pattern');
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
  const config = await loadStandaloneConfig(args.configPath, args.overrides);
  const service = new StandaloneJiraMrPollingService(config, { logger });
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

module.exports = {
  main,
  parseArgs
};