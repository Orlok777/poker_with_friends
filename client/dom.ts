// Small DOM and storage helpers shared by every screen.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const fmt = (n: number): string => n.toLocaleString('en-US');

export function storageGet(key: string, area: Storage = localStorage): string | null {
  try {
    return area.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null, area: Storage = localStorage): void {
  try {
    if (value === null) area.removeItem(key);
    else area.setItem(key, value);
  } catch {
    // Storage can be blocked (private windows). Everything still works without it.
  }
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
