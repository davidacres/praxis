import { forwardRef, type HTMLAttributes } from 'react';
import { useSettings } from '../settings/useSettings';
import { ComposerPresentationContext, composerPresentationAttributes } from '../ui/composerPresentation';
import { AmbientControlsProvider } from './AmbientComposerControls';

/**
 * Scope the whole composer, including usage/footer and portalled menus.
 * Styles supply --composer-* tokens in composerPresentation.css. Shared parts
 * (controls, menu, send, usage and analysis) consume them; Classic has no overrides.
 */
export const ComposerSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { part?: string }>(function ComposerSurface({ children, part, ...props }, ref) {
  const { settings } = useSettings();
  const style = settings?.appearance.composerStyle ?? 'classic';
  return <ComposerPresentationContext.Provider value={style}>
    <div ref={ref} {...props} {...composerPresentationAttributes(style)} data-composer-part={part}>
      {part === 'scope' ? <AmbientControlsProvider>{children}</AmbientControlsProvider> : children}
    </div>
  </ComposerPresentationContext.Provider>;
});
