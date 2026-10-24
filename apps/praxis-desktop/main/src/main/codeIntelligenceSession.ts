import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CODE_INTELLIGENCE_SERVER_NAME, type AppSettings, type CodeIntelligenceResponse, type McpServerConfig } from '@praxis/core';

interface SessionDependencies {
  settings: AppSettings['ai']['codeIntelligence'];
  runtime(): { executable: string; assembly?: string; contracts: string };
  nodeExecutable: string;
  bridgePath: string;
  dataDirectory: string;
  settingsPath: string;
  invoke(args: string[]): Promise<CodeIntelligenceResponse>;
  installedModelFingerprint(): Promise<string | undefined>;
  activateModel(fingerprint: string, repositoryIds: string[]): Promise<string[]>;
  warn(message: string, error: unknown): void;
}

/** Attach code and knowledge tools independently of whether a session has a folder. */
export async function sessionCodeIntelligenceServer(
  workingDirectory: string | undefined,
  provider: string | undefined,
  dependencies: SessionDependencies
): Promise<McpServerConfig | undefined> {
  if (!provider) return undefined;
  try {
    const config = dependencies.settings;
    const globalEnabled = config?.enabled ?? true;
    const normalizedDir = workingDirectory ? path.resolve(workingDirectory) : undefined;
    const override = normalizedDir && workingDirectory
      ? config?.projectOverrides?.[normalizedDir] ?? config?.projectOverrides?.[workingDirectory]
      : undefined;
    const isEnabled = override !== undefined ? override : globalEnabled;
    if (!isEnabled) return undefined;

    const runtime = dependencies.runtime();
    if (!existsSync(runtime.contracts)) throw new Error('Code intelligence contracts are missing.');

    const server = (repositoryId: string): McpServerConfig => ({
      id: `praxis-code-intelligence-${createHash('sha256').update(JSON.stringify([repositoryId, provider])).digest('hex').slice(0, 24)}`,
      name: CODE_INTELLIGENCE_SERVER_NAME, enabled: true, transport: 'stdio', requireApproval: false,
      command: dependencies.nodeExecutable,
      args: [dependencies.bridgePath, runtime.executable, runtime.assembly || '-', dependencies.dataDirectory, repositoryId, provider, runtime.contracts],
      env: {
        ELECTRON_RUN_AS_NODE: '1', PRAXIS_CODE_INTELLIGENCE_PROVIDER: provider,
        PRAXIS_CODE_INTELLIGENCE_SETTINGS_PATH: dependencies.settingsPath,
        ...(workingDirectory ? { PRAXIS_CODE_INTELLIGENCE_WORKING_DIRECTORY: workingDirectory } : {})
      }
    });
    // Knowledge lookup does not require a working folder. This scope grants nothing new.
    if (!workingDirectory) return server('*');

    try {
      const listResponse = await dependencies.invoke(['list']);
      if (listResponse.error) throw new Error(listResponse.error.message);

      const list = Array.isArray(listResponse.data) ? (listResponse.data as Array<Record<string, unknown>>) : [];
      let repo = list.find(r => typeof r.root === 'string' && (path.resolve(r.root) === normalizedDir || r.root === workingDirectory));

      if (!repo) {
        const regResponse = await dependencies.invoke(['register', workingDirectory]);
        if (regResponse.error) throw new Error(regResponse.error.message);
        const repoId = (regResponse.data as Record<string, unknown>)?.repositoryId;
        if (typeof repoId !== 'string') throw new Error('Repository registration returned no ID.');
        void dependencies.invoke(['index', repoId]).then(result => {
          if (result.error) dependencies.warn('Code intelligence indexing failed:', result.error.message);
        }).catch(error => dependencies.warn('Code intelligence indexing failed:', error));
        repo = { id: repoId, root: workingDirectory };
      }

      if (typeof repo.id !== 'string' || !repo.id) throw new Error('Repository listing returned no ID.');
      const repositoryId = repo.id;
      const fp = await dependencies.installedModelFingerprint().catch(() => undefined);
      if (fp) {
        const failures = await dependencies.activateModel(fp, [repositoryId]);
        if (failures.length) dependencies.warn('Semantic model activation failed:', failures.join('; '));
      }
      const grant = await dependencies.invoke(['grant', repositoryId, '--client', provider]);
      if (grant.error) throw new Error(grant.error.message);

      return server(repositoryId);
    } catch (error) {
      // Keep discovery and previously granted knowledge available even if the current
      // folder cannot be registered. The owner still checks every query's grant.
      dependencies.warn('Code intelligence folder setup failed; using existing grants:', error);
      return server('*');
    }
  } catch (error) {
    dependencies.warn('Code intelligence is unavailable for this session:', error);
    return undefined;
  }
}
