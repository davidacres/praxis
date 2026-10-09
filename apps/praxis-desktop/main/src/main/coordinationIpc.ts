import { ipcMain } from 'electron';
import { stopService } from '@praxis/core';
import { getAcpAgentHost, getVercelAgentService, hasActiveTask } from './aiInstance';
import { endCoordinatedTurn, getCoordination, onCoordinationChanged } from './coordinationInstance';
import { broadcastToAllWindows } from './windowBroadcast';

/**
 * Coordination for the renderer (FX-BF-048 / TASK-394): the broker's state to show who
 * holds what and who is waiting, and the one action a person takes — confirming that a
 * claim awaiting recovery really stopped. A turn that settles releases its claims here.
 */
export function registerCoordinationIpc(): void {
  const settle = (issueKey: string) => {
    if (!hasActiveTask(issueKey)) endCoordinatedTurn(issueKey);
  };
  getVercelAgentService().onDidChangeActiveTask(settle);
  getAcpAgentHost().onDidChangeActiveTask(settle);

  onCoordinationChanged(() => broadcastToAllWindows('coordination:changed'));

  // Joined at startup, not on first use: a native hook adapter needs a broker to ask
  // whenever Praxis is open, even before any session here has touched a file.
  if (process.env.PRAXIS_COORDINATION !== 'off') void getCoordination().snapshot().catch(() => undefined);

  ipcMain.handle('coordination:state', async () => {
    const coordination = getCoordination();
    const state = await coordination.snapshot();
    return { state, role: coordination.role, blockedReason: coordination.blockedReason ?? null };
  });

  ipcMain.handle('coordination:recover', async (_event, claimId: string, note: string) => {
    const result = await getCoordination().send({ kind: 'recover', claimId, actor: 'you, in Praxis', note: note.trim() || 'Confirmed in Praxis that the work stopped.' });
    if (!result.ok) throw new Error(result.error);
  });

  ipcMain.handle('coordination:stopService', async (_event, pgid: unknown) => {
    if (typeof pgid !== 'number' || !Number.isInteger(pgid) || pgid <= 1) return false;
    return stopService(pgid);
  });
}
