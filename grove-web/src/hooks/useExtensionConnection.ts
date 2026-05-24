// Shared "Chrome companion extension connected?" status. Three call sites
// (SettingsPage, TaskChat, AddLinkDialog) used to each run their own
// fetch-on-interval — at 3–5s each, that's 2 req/s with a handful of open
// chats. This hook keeps a single module-level subscription that all of
// them share.
//
// Cancellation model: a `generation` counter increments on every
// stopPolling. Each in-flight `tick()` captures the generation it started
// in; when it resolves, it checks the captured generation against the
// current one. If they differ the result is dropped — no matter when the
// fetch completes relative to subscribe/unsubscribe churn. This avoids
// the closure / `_active` tricks that were fragile under StrictMode and
// rapid mount/unmount.
import { useEffect, useState } from "react";
import { pingExtension } from "../api/extension";

type Listener = (connected: boolean) => void;

let pollHandle: ReturnType<typeof setInterval> | null = null;
let lastValue = false;
let generation = 0;
const subscribers = new Set<Listener>();
const POLL_INTERVAL_MS = 5000;

function notify(connected: boolean) {
  lastValue = connected;
  for (const fn of subscribers) {
    try {
      fn(connected);
    } catch {
      // listener bugs shouldn't kill the polling loop
    }
  }
}

async function tick(myGeneration: number) {
  const connected = await pingExtension();
  // Drop the result if a stopPolling happened (or another restart fired)
  // between the start of this fetch and its resolution.
  if (myGeneration !== generation) return;
  if (connected !== lastValue) {
    notify(connected);
  }
}

function startPolling() {
  if (pollHandle !== null) return;
  const myGeneration = generation;
  void tick(myGeneration);
  pollHandle = setInterval(() => {
    void tick(generation);
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollHandle === null) return;
  clearInterval(pollHandle);
  pollHandle = null;
  // Invalidate any in-flight tick — when its `pingExtension()` resolves
  // it will see a different generation and bail.
  generation += 1;
}

/** Subscribe to extension connection status. Polling auto-starts on first
 *  subscriber and stops when the last unsubscribes. */
export function useExtensionConnection(): boolean {
  // Initialize from the cached module-level value so the consumer renders
  // the right state on first paint without waiting for the next poll tick.
  const [connected, setConnected] = useState(lastValue);

  useEffect(() => {
    subscribers.add(setConnected);
    if (subscribers.size === 1) startPolling();
    return () => {
      subscribers.delete(setConnected);
      if (subscribers.size === 0) stopPolling();
    };
  }, []);

  return connected;
}
