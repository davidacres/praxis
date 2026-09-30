import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@praxis/core';

/**
 * The main process's update state, kept live. The main process checks on its
 * own schedule and pushes every transition; this only reads the current value
 * on mount and follows the pushes.
 */
export function useUpdateStatus(): UpdateStatus | undefined {
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    let live = true;
    const stop = window.praxis.app.update.onStatus(next => setStatus(next));
    void window.praxis.app.update.getStatus().then(current => {
      if (live) setStatus(prev => prev ?? current);
    }).catch(() => undefined);
    return () => { live = false; stop(); };
  }, []);
  return status;
}
