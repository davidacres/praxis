import type { AiProvider } from '@praxis/core';
import { ProviderBrandLogo } from './ProviderBrandLogo';
import { providerLabel } from './modelProviders';

export interface SessionAiIconsProps {
  providers: string[];
  size?: number;
  className?: string;
}

export function SessionAiIcons({ providers, size = 14, className = '' }: SessionAiIconsProps) {
  if (!providers || providers.length === 0) return null;

  const tooltip = providers
    .map(p => providerLabel(p as AiProvider) || p)
    .join(' · ');

  return (
    <span
      className={`session-ai-icons-cluster ${className}`}
      data-testid="session-ai-icons"
      title={tooltip}
      aria-label={`AI providers: ${tooltip}`}
    >
      {providers.map((p, index) => (
        <span
          key={`${p}-${index}`}
          className="session-ai-icon-badge"
          data-provider={p}
          data-testid={`session-ai-icon-${p}`}
        >
          <ProviderBrandLogo provider={p} size={size} />
        </span>
      ))}
    </span>
  );
}
