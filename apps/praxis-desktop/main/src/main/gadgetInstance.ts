import * as path from 'node:path';
import { app } from 'electron';
import { GadgetService, type GadgetScope } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { getAiSessionManager } from './aiInstance';
import { getHostId } from './hostIdentity';

let instance: GadgetService | undefined;

/**
 * Singleton gadget service.
 *
 * Backed by its own JSON file under `userData`: published blocks and the action
 * ledger are append-heavy and must outlive a restart, and keeping them out of
 * the shared settings document means a corrupt ledger can never take settings
 * down with it.
 *
 * The policy is permissive here because desktop-local Praxis has no gate state
 * of its own to consult — gates belong to a workflow run, and `workflowIpc`
 * already enforces them at the point a run advances. A gadget action that
 * *executes* still goes through the same service as any other caller, so this
 * is not a second approval path; see `registerGadgetIpc`'s executor.
 */
export function getGadgetService(): GadgetService {
  if (!instance) {
    instance = new GadgetService({
      hostId: getHostId(),
      store: new JsonKeyValueStore(path.join(app.getPath('userData'), 'gadgets.json'))
    });
  }
  return instance;
}

export function resetGadgetService(): void {
  instance = undefined;
}

/**
 * The scope a session's gadgets are issued and answered against.
 *
 * Minted from the live session record, and used for **both** publishing and
 * submitting, so the two can never disagree about what a gadget belongs to. A
 * session that no longer exists yields `undefined`, which the caller turns into
 * a scope mismatch rather than a silent success.
 *
 * `revision` is deliberately left unset. It exists for the multi-device case,
 * where a second client must prove it is acting on current state; a desktop
 * session has no cheap monotonic marker that isn't also wrong — deriving one
 * from the event count would expire a gadget the moment the agent emitted its
 * next event, which is exactly while the user is still reading it.
 */
export function resolveSessionScope(sessionId: string): GadgetScope | undefined {
  // Agent sessions are stored keyed by issue key, so the session ID has to be
  // looked up across the values rather than fetched directly.
  const record = [...getAiSessionManager().getAllAgentSessions().values()].find(
    session => session.sessionId === sessionId
  );
  if (!record) return undefined;
  return {
    hostId: getHostId(),
    sessionId,
    projectId: record.connectionId || undefined,
    workId: record.issueKey || undefined
  };
}
