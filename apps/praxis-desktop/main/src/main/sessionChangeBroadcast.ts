import { createSessionChangeEncoder } from '@praxis/core';

/**
 * The one encoder behind `ai:sessionChanged`. Shared so deleting a session
 * also forgets what was last pushed for it.
 */
export const sessionChangeEncoder = createSessionChangeEncoder();
