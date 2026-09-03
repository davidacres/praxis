/** Which catalog item the Agents route has selected. */
export type CatalogSelection = { kind: 'agent'; id: string } | { kind: 'skill'; name: string };

/** Skill name → the mode the runtime negotiated when it was activated on an agent. */
export type ActivationMap = Record<string, Array<{ skill: string; mode: string }>>;

export type LifecycleAction = 'start' | 'stop' | 'restart';
