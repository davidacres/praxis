import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentPermissionMode } from '@praxis/core';
import { Icon } from '../ui/Icon';

export const PERMISSION_MODE_OPTIONS: Array<{
  value: AgentPermissionMode;
  label: string;
  description: string;
  icon: 'shield' | 'zap' | 'rocket' | 'tools';
}> = [
  { value: 'manual', label: 'Manual', description: 'Ask before every action that needs permission.', icon: 'shield' },
  { value: 'auto', label: 'Auto', description: 'Allow safe checks automatically and pause for anything risky.', icon: 'zap' },
  { value: 'autopilot', label: 'Autopilot', description: 'Continue independently, answer routine questions, and approve permitted actions.', icon: 'rocket' },
  { value: 'bypass', label: 'Bypass permissions', description: 'Allow permitted tools without asking during this session.', icon: 'tools' }
];

interface SessionPermissionModeControlProps {
  value: AgentPermissionMode | undefined;
  onChange: (value: AgentPermissionMode) => void;
  testId: string;
  disabled?: boolean;
}

/** Visible below an expanded composer so the session policy is always discoverable. */
export function SessionPermissionModeControl({ value = 'manual', onChange, testId, disabled = false }: SessionPermissionModeControlProps) {
  const [menuPosition, setMenuPosition] = useState<{ bottom: number; left: number }>();
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selected = PERMISSION_MODE_OPTIONS.find(option => option.value === value) ?? PERMISSION_MODE_OPTIONS[0];

  useEffect(() => {
    if (!menuPosition) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      setMenuPosition(undefined);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, [menuPosition]);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`composer-chip session-permission-chip${menuPosition ? ' active' : ''}`}
        data-testid={`${testId}-permission-chip`}
        aria-haspopup="listbox"
        aria-expanded={Boolean(menuPosition)}
        disabled={disabled}
        onClick={() => {
          if (menuPosition) {
            setMenuPosition(undefined);
            return;
          }
          const rect = chipRef.current?.getBoundingClientRect();
          if (rect) setMenuPosition({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
        }}
      >
        <Icon name={selected.icon} size={14} />
        <span>{selected.label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {menuPosition && createPortal(
        <div
          ref={menuRef}
          className="composer-provider-menu session-permission-menu"
          role="listbox"
          aria-label="Permission mode"
          style={{ position: 'fixed', bottom: menuPosition.bottom, left: menuPosition.left }}
        >
          <div className="popover-label">Permissions</div>
          {PERMISSION_MODE_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              className={`composer-provider-option session-permission-option${value === option.value ? ' active' : ''}`}
              data-testid={`${testId}-permission-option-${option.value}`}
              role="option"
              aria-selected={value === option.value}
              onClick={() => {
                onChange(option.value);
                setMenuPosition(undefined);
              }}
            >
              <Icon name={option.icon} size={16} />
              <span className="heading-option-body">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {value === option.value && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
