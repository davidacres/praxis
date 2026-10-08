import React from 'react';
import { Icon } from '../../ui/Icon';

export interface SectionHeaderProps {
  title: string;
  count?: number;
  onAdd: () => void;
  addAriaLabel: string;
  testId?: string;
  containerTestId?: string;
  className?: string;
}

/**
 * Standard section header for EasyMode: Title on the left, optional count,
 * right-aligned `+` action button with aria-label on the same line.
 */
export function SectionHeader({
  title,
  count,
  onAdd,
  addAriaLabel,
  testId,
  containerTestId,
  className
}: SectionHeaderProps) {
  return (
    <div
      className={`easymode-section-header ${className ?? ''}`.trim()}
      data-testid={containerTestId ?? `section-header-${title.toLowerCase()}`}
    >
      <div className="easymode-section-header__title-group">
        <span className="easymode-section-header__title">{title}</span>
        {typeof count === 'number' && (
          <span className="easymode-section-header__count">{count}</span>
        )}
      </div>
      <button
        type="button"
        className="easymode-btn-add"
        aria-label={addAriaLabel}
        title={addAriaLabel}
        data-testid={testId ?? `section-header-add-${title.toLowerCase()}`}
        onClick={onAdd}
      >
        <Icon name="plus" size={13} />
      </button>
    </div>
  );
}
