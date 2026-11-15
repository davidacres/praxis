import { createContext, useContext, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ComposerPresentationContext } from '../ui/composerPresentation';

const AmbientControlsContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
}>({ target: null, setTarget: () => {} });

/** A single controls destination shared by the frame and its footer. */
export function AmbientControlsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <AmbientControlsContext.Provider value={{ target, setTarget }}>{children}</AmbientControlsContext.Provider>;
}

export const useAmbientControls = () => useContext(AmbientControlsContext);

/** Keep the real controls and their handlers; Ambient places them in one row. */
export function ComposerAuxiliary(props: HTMLAttributes<HTMLDivElement>) {
  const style = useContext(ComposerPresentationContext);
  const { target } = useAmbientControls();
  const content = <div {...props} />;
  return style === 'ambient-canvas' ? target && createPortal(content, target) : content;
}
