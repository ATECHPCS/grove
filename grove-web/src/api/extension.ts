// Grove Chrome Companion extension API — proxies tab queries through the
// connected extension over the backend WebSocket bridge. Going through
// apiClient (not raw fetch) keeps mobile-mode HMAC signing intact.
import { apiClient } from './client';

/** A browser tab as reported by the Chrome companion extension. */
export interface ExtensionTab {
  /** Chrome's internal tab id. May be missing if the tab is being discarded. */
  id?: number;
  /** Page <title> or url fallback. */
  title: string;
  /** Full URL of the tab. */
  url: string;
  /** Favicon URL if Chrome resolved one. */
  favIconUrl?: string;
}

/**
 * List currently open browser tabs (via the connected Chrome companion).
 * Throws when the extension is offline / backend is unreachable; callers
 * decide how to render the failure (empty state vs explicit "Disconnected").
 */
export async function listExtensionTabs(): Promise<ExtensionTab[]> {
  return apiClient.get<ExtensionTab[]>('/api/v1/extension/tabs');
}

/**
 * Probe whether the Chrome companion extension is reachable. Used by the
 * Settings page status indicator. Implemented as a thin wrapper around
 * `listExtensionTabs` so we don't ping a separate health endpoint.
 */
export async function pingExtension(): Promise<boolean> {
  try {
    await apiClient.get<ExtensionTab[]>('/api/v1/extension/tabs');
    return true;
  } catch {
    return false;
  }
}
