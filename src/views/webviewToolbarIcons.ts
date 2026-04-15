export type ToolbarIconName = 'add' | 'columns' | 'refresh' | 'filter' | 'edit' | 'link' | 'delete';

function getIconPath(name: ToolbarIconName): string {
  switch (name) {
    case 'add':
      return '<path d="M8 3v10M3 8h10" />';
    case 'columns':
      return '<path d="M2.5 3.5h3v9h-3zM6.5 3.5h3v9h-3zM10.5 3.5h3v9h-3z" />';
    case 'refresh':
      return '<path d="M11 4.5V1.75L13.25 4M12.5 7.25a4.75 4.75 0 1 1-1.1-3.05L13.25 4" />';
    case 'filter':
      return '<path d="M2.5 3.5h11l-4.25 4.5v3l-2.5 1v-4z" />';
    case 'edit':
      return '<path d="M3 11.75 4 9l5.75-5.75 2.75 2.75L6.75 11.75 3 12.5zM8.75 4.25l2.75 2.75" />';
    case 'link':
      return '<path d="M6.25 9.75 4.5 11.5a2.12 2.12 0 1 1-3-3L3.25 6.75M9.75 6.25 11.5 4.5a2.12 2.12 0 1 1 3 3l-1.75 1.75M5.5 10.5l5-5" />';
    case 'delete':
      return '<path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5v5M8 6.5v5M11 6.5v5M4.5 4.5l.5 8h6l.5-8" />';
  }
}

export function renderIconButton(
  id: string,
  label: string,
  icon: ToolbarIconName,
  extraClass = ''
): string {
  const className = extraClass ? `icon-button ${extraClass}` : 'icon-button';
  return `<button class="${className}" id="${id}" type="button" title="${label}" aria-label="${label}">
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      ${getIconPath(icon)}
    </svg>
  </button>`;
}
