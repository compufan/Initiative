/** Small formatting helpers shared by client and server (notifications, ICS). */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** One-line preview of a message, used in chat lists and push notifications. */
export function messagePreview(message: {
  type: string;
  body?: string | null;
  deletedAt?: string | null;
}): string {
  if (message.deletedAt) return 'Nachricht gelöscht';
  switch (message.type) {
    case 'image':
      return '📷 Foto';
    case 'video':
      return '🎬 Video';
    case 'audio':
      return '🎤 Sprachnachricht';
    case 'file':
      return '📎 Datei';
    case 'sticker':
      return '🌟 Sticker';
    case 'poll':
      return '📊 Umfrage';
    case 'event':
      return '📅 Termin';
    case 'game':
      return '🎮 Spiel';
    default:
      return message.body?.trim() ? message.body.trim() : 'Nachricht';
  }
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}
