/**
 * Telling "the check found a problem" from "the check could not run".
 *
 * A check stage exits non-zero for two very different reasons. Its verdict is
 * negative (tests failed, vulnerabilities found) — that is a genuine failure and
 * must fail the stage. Or its tooling could not do the job at all: the package
 * registry does not serve the request, the command is not installed, the network
 * is down. That says nothing about the work, so failing the run for it — and
 * spending the stage's only attempt — throws away everything upstream for a
 * problem the user fixes in a minute.
 *
 * This is deliberately narrow. A false "environment" verdict hides a real failure
 * behind a pause, which is worse than a false failure, so it only fires on:
 * - a command that does not exist (spawn ENOENT, or exit 127), and
 * - a package manager doing *registry work* (audit / install / view / …) whose
 *   output carries a specific registry or network signature.
 * `npm test`, `npm run …` and every other command run user code, and their output
 * is never second-guessed.
 */

export type CheckEnvironmentFailureKind =
  | 'command-not-found'
  | 'registry-audit-unsupported'
  | 'registry-auth'
  | 'network'
  | 'tls';

export interface CheckEnvironmentFailure {
  kind: CheckEnvironmentFailureKind;
  /** One sentence, what stopped the check from running. */
  reason: string;
  /** What to do about it. */
  hint: string;
}

export interface CheckEnvironmentInput {
  command: string;
  args?: string[];
  /** Process exit code, when it ran. */
  exitCode?: number | null;
  /** Combined stdout + stderr (already redacted is fine). */
  output: string;
  /** Spawn-level error text (`ENOENT`, …), when the process never started. */
  spawnError?: string;
}

const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun']);

/** Subcommands that talk to a registry — never `test`, `run`, `exec` or a script name. */
const REGISTRY_SUBCOMMANDS = new Set([
  'audit', 'install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'outdated', 'view', 'info', 'ping', 'whoami', 'publish', 'dedupe'
]);

function baseName(command: string): string {
  const name = command.trim().split(/[\\/]/).pop() ?? command;
  return name.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
}

function subcommand(args: string[] | undefined): string | undefined {
  return (args ?? []).find(arg => !arg.startsWith('-'))?.toLowerCase();
}

/** Host of the registry request that failed, when the output names one. */
function failedHost(output: string): string | undefined {
  return output.match(/\b(?:GET|POST|PUT|HEAD)\s+https?:\/\/([^/\s]+)/i)?.[1];
}

export function classifyCheckEnvironmentFailure(input: CheckEnvironmentInput): CheckEnvironmentFailure | undefined {
  const command = baseName(input.command);
  const spawnError = input.spawnError ?? '';

  if (/ENOENT|not found|not recognized/i.test(spawnError) || input.exitCode === 127) {
    return {
      kind: 'command-not-found',
      reason: `"${input.command}" was not found on this machine.`,
      hint: `Install ${input.command} (or fix the stage's command), then retry.`
    };
  }

  if (!PACKAGE_MANAGERS.has(command)) return undefined;
  const sub = subcommand(input.args);
  if (!sub || !REGISTRY_SUBCOMMANDS.has(sub)) return undefined;
  const out = input.output;

  if (sub === 'audit' && /audit endpoint returned an error|advisories\/bulk|npm warn audit (?:40\d|50\d)|audit.{0,20}\b(?:404|501)\b/i.test(out)) {
    const host = failedHost(out);
    return {
      kind: 'registry-audit-unsupported',
      reason: `${host ? `The package registry ${host}` : 'The configured package registry'} does not support security audits.`,
      hint: 'Point this stage at the public registry, for example by adding --registry=https://registry.npmjs.org/ to its arguments, then retry.'
    };
  }

  if (/\b(?:E401|E403|ENEEDAUTH)\b|unable to authenticate|401 Unauthorized/i.test(out)) {
    const host = failedHost(out);
    return {
      kind: 'registry-auth',
      reason: `${host ? `The package registry ${host}` : 'The package registry'} rejected the credentials.`,
      hint: 'Check the auth token in your .npmrc, then retry.'
    };
  }

  if (/self[- ]signed certificate|UNABLE_TO_GET_ISSUER_CERT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(out)) {
    return {
      kind: 'tls',
      reason: 'The package registry\'s TLS certificate could not be verified.',
      hint: 'Fix the certificate or proxy configuration, then retry.'
    };
  }

  if (/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|network (?:request|connectivity|error)|request to https?:\/\/\S+ failed/i.test(out)) {
    return {
      kind: 'network',
      reason: 'The package registry could not be reached.',
      hint: 'Check the network or proxy, then retry.'
    };
  }

  return undefined;
}
