import { useEffect, useState } from 'react';
import { sessionAgentOptions, type SessionAgentOption } from './agentCatalog';

/**
 * The agents a session can be given, read straight from the agent runtime so that any composer
 * (including a detached chat window) can offer them without the caller threading a list through.
 */
export function useSessionAgentOptions(): SessionAgentOption[] {
  const [options, setOptions] = useState<SessionAgentOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.praxis.agentRuntime.list()
      .then(snapshot => { if (!cancelled) setOptions(sessionAgentOptions(snapshot)); })
      .catch(() => { if (!cancelled) setOptions([]); });
    return () => { cancelled = true; };
  }, []);
  return options;
}
