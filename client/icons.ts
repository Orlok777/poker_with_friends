// Inline SVG icons, drawn on a 24×24 grid with round strokes. No icon font or files.

const PATHS = {
  hit: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  stand:
    '<path d="M8 12.5V6.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4.5a1.5 1.5 0 0 1 3 0v6M14 10.5V6a1.5 1.5 0 0 1 3 0v7.5c0 4-2.6 7-6.2 7-2.6 0-4-1.2-5.6-3.8l-2-3.4a1.5 1.5 0 0 1 2.5-1.6L8 13.5"/>',
  double: '<rect x="3.5" y="7" width="11" height="14" rx="2"/><path d="M8.5 3.5h10a2 2 0 0 1 2 2V17"/>',
  soundOn: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.2 6.5a8 8 0 0 1 0 11"/>',
  soundOff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  rules: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/>',
  log: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  leave: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16.5 5.5 12 10 7.5M5.5 12H15"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  repeat: '<path d="M4 11.5a7.5 7.5 0 0 1 13.4-4.6M18.5 3.5v4h-4M20 12.5a7.5 7.5 0 0 1-13.4 4.6M5.5 20.5v-4h4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/>',
  disconnected: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0M12 19.5h.01M4 4l16 16"/>',
  share:
    '<circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="6" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="M8.7 10.8l6.6-3.6M8.7 13.2l6.6 3.6"/>',
  kicked: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

/** Replaces the contents of every `[data-icon]` element with its icon. */
export function hydrateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = el.dataset.icon as IconName;
    if (name in PATHS) el.replaceChildren(icon(name));
  }
}
