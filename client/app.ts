// State shared by the screens: the socket, who we are and the latest table state.

import type { ClientMsg, PlayerView, TableState } from '../shared/types.js';
import { $, fmt } from './dom.js';

export const app = {
  ws: null as WebSocket | null,
  joined: false,
  myId: null as string | null,
  state: null as TableState | null,
  prevState: null as TableState | null,
  /** Server clock minus local clock, so countdowns match the server. */
  clockOffset: 0,
};

export function send(msg: ClientMsg): void {
  const ws = app.ws;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function me(): PlayerView | undefined {
  return app.state?.players.find((p) => p.id === app.myId);
}

export function isHost(): boolean {
  return app.state !== null && app.state.hostId === app.myId;
}

export function serverNow(): number {
  return Date.now() + app.clockOffset;
}

let toastTimer = 0;

export function toast(message: string): void {
  const node = $('toast');
  node.textContent = message;
  node.hidden = true;
  void node.offsetWidth; // restart the slide-in animation
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (node.hidden = true), 4500);
}

export function confirmKick(p: PlayerView): void {
  if (confirm(`Kick ${p.name}? They can not rejoin until the server restarts.`)) {
    send({ type: 'kick_player', playerId: p.id });
  }
}

export function resetChips(): void {
  if (!app.state) return;
  if (confirm(`Reset your chips to ${fmt(app.state.settings.startingChips)}?`)) send({ type: 'reset_chips' });
}
