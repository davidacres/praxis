import { useId } from 'react';
import type { BackendMode } from '@praxis/core';

/**
 * Brand artwork for each backend mode, ported from the VS Code extension's
 * `views/boardModeIcon.ts` (`boardListModeIconSvg`). Shown in the board list
 * when the `appearance.showBrandArtwork` setting is on; otherwise the generic
 * per-board-type glyphs from `boardMeta.ts` are used.
 *
 * The Jira, GitHub and GitLab marks carry their own brand fills; the demo and
 * folder marks use `currentColor`, so the caller's text color (the connection
 * group's tone) applies.
 */
export function BrandModeIcon({ mode, size = 15 }: { mode: BackendMode; size?: number }) {
  // Namespace the Jira gradient ids per instance — several Jira boards in one
  // list would otherwise emit duplicate `paint0_linear` ids.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  return (
    <span
      className="brand-mode-icon"
      data-testid="board-brand-icon"
      data-mode={mode}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {renderMark(mode, size, uid)}
    </span>
  );
}

function renderMark(mode: BackendMode, size: number, uid: string) {
  switch (mode) {
    case 'jiracloud':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path
            d="M30.2 0H15.6C15.6 3.6 18.5 6.6 22.1 6.6H24.7V9.2C24.7 12.8 27.6 15.8 31.2 15.8V1C31.2 0.4 30.8 0 30.2 0Z"
            fill="#0052CC"
          />
          <path
            d="M22.1 8H7.5C7.5 11.6 10.4 14.6 14 14.6H16.6V17.2C16.6 20.8 19.5 23.8 23.1 23.8V9C23.1 8.4 22.7 8 22.1 8Z"
            fill={`url(#${uid}paint0)`}
          />
          <path
            d="M14 16H0C0 19.6 2.9 22.6 6.5 22.6H9.1V25.2C9.1 28.8 12 31.8 15.6 31.8V17C15.6 16.4 15.2 16 14 16Z"
            fill={`url(#${uid}paint1)`}
          />
          <defs>
            <linearGradient id={`${uid}paint0`} x1="22.9" y1="9.5" x2="16.4" y2="16.7" gradientUnits="userSpaceOnUse">
              <stop offset="0.18" stopColor="#0052CC" />
              <stop offset="1" stopColor="#2684FF" />
            </linearGradient>
            <linearGradient id={`${uid}paint1`} x1="14.2" y1="16.9" x2="7.7" y2="24.2" gradientUnits="userSpaceOnUse">
              <stop offset="0.18" stopColor="#0052CC" />
              <stop offset="1" stopColor="#2684FF" />
            </linearGradient>
          </defs>
        </svg>
      );
    case 'gitlab':
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
          <polygon points="16 28.896 16 28.896 21.156 13.029 10.844 13.029 16 28.896" fill="#e24329" />
          <polygon points="16 28.896 10.844 13.029 3.619 13.029 16 28.896" fill="#fc6d26" />
          <path
            d="M3.619,13.029h0L2.052,17.851a1.067,1.067,0,0,0,.388,1.193L16,28.9,3.619,13.029Z"
            fill="#fca326"
          />
          <path
            d="M3.619,13.029h7.225L7.739,3.473a.534.534,0,0,0-1.015,0L3.619,13.029Z"
            fill="#e24329"
          />
          <polygon points="16 28.896 21.156 13.029 28.381 13.029 16 28.896" fill="#fc6d26" />
          <path
            d="M28.381,13.029h0l1.567,4.822a1.067,1.067,0,0,1-.388,1.193L16,28.9,28.381,13.029Z"
            fill="#fca326"
          />
          <path
            d="M28.381,13.029H21.156l3.105-9.557a.534.534,0,0,1,1.015,0l3.105,9.557Z"
            fill="#e24329"
          />
        </svg>
      );
    case 'github':
      return (
        <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M7 1.2A5.8 5.8 0 0 0 5.17 12.5c.29.05.4-.13.4-.28v-1c-1.62.35-1.96-.78-1.96-.78a1.54 1.54 0 0 0-.65-.85c-.53-.36.04-.35.04-.35a1.22 1.22 0 0 1 .9.6 1.24 1.24 0 0 0 1.7.48 1.24 1.24 0 0 1 .37-.78c-1.3-.15-2.66-.65-2.66-2.87a2.25 2.25 0 0 1 .6-1.56 2.09 2.09 0 0 1 .06-1.54s.49-.16 1.6.6a5.5 5.5 0 0 1 2.9 0c1.11-.75 1.6-.6 1.6-.6a2.09 2.09 0 0 1 .06 1.54 2.25 2.25 0 0 1 .6 1.56c0 2.23-1.36 2.72-2.66 2.86a1.39 1.39 0 0 1 .4 1.08v1.6c0 .19.1.34.4.28A5.8 5.8 0 0 0 7 1.2z"
            fill="currentColor"
          />
        </svg>
      );
    case 'demo':
      return (
        <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
          <path d="M4.2 2.8v8.4l7.3-4.2-7.3-4.2z" fill="currentColor" />
        </svg>
      );
    case 'folder':
    case 'userworkspace':
      return (
        <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M2 3.5h3.5l1 1.5H12v6H2V3.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M5 8h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
  }
}
