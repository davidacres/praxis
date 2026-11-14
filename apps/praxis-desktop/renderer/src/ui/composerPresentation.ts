import { createContext } from 'react';

/** Presentation follows React context through portals; unrelated pickers stay Classic. */
export const ComposerPresentationContext = createContext('classic');
export function composerPresentationAttributes(style: string) {
  return {
    'data-composer-style': style,
    'data-composer-custom': style === 'classic' ? undefined : true
  };
}
