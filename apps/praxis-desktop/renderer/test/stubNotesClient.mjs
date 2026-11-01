// Calls are routed to handlers the test installs on globalThis.__notesApi.
export const notesClient = {
  create: (...args) => globalThis.__notesApi.create(...args),
  update: (...args) => globalThis.__notesApi.update(...args)
};
