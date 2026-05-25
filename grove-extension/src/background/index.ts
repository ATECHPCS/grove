/// <reference types="vite/client" />
// Grove Companion Background Script
// Maintains WebSocket connection to Grove Local App and listens for commands.

console.log('[Grove Background] Started.');

// ==========================================
// ⚡ Development Auto-Reload Protocol
// ==========================================
// In development mode, standard Vite dev watches for changes, and our custom
// WebSocket server on ws://localhost:8080 triggers a hard extension reload.
if (import.meta.env.DEV) {
  console.log('[Grove Background] Dev Mode active. Connecting to auto-reloader...');
  const reloadWs = new WebSocket('ws://localhost:8080');
  
  reloadWs.onopen = () => {
    console.log('[Grove Background] Connected to auto-reloader WebSocket.');
  };

  reloadWs.onmessage = (event) => {
    if (event.data === 'reload') {
      console.log('[Grove Background] Reload signal received. Restarting extension...');
      chrome.runtime.reload();
    }
  };

  reloadWs.onerror = (err) => {
    console.warn('[Grove Background] Auto-reloader error:', err);
  };
}

// ==========================================
// 🧪 Injected functions for chrome.scripting.executeScript
// ==========================================
// These run inside the target tab, not the service worker. They must be
// self-contained — closures over module-level state will not survive the
// serialize-and-eval boundary. Helper functions live as `const` inside the
// outer function so the engine ships them all together.

function a11yTreeInjected(): { success: boolean; a11yTree?: string; error?: string } {
  try {
    let nextRefId = 1;
    const isInteractive = (el: HTMLElement): boolean => {
      const tag = el.tagName.toLowerCase();
      if (['button', 'input', 'select', 'textarea', 'a'].includes(tag)) return true;
      if (el.getAttribute('role') === 'button' || el.getAttribute('onclick')) return true;
      if (window.getComputedStyle(el).cursor === 'pointer') return true;
      return false;
    };
    const assignRef = (el: HTMLElement): string => {
      let ref = el.getAttribute('data-grove-ref');
      if (!ref) {
        ref = `@e${nextRefId++}`;
        el.setAttribute('data-grove-ref', ref);
      }
      return ref;
    };
    const walk = (node: Node, depth: number): string => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        return text ? `${'  '.repeat(depth)}"${text}"\n` : '';
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'head', 'noscript', 'svg', 'path'].includes(tag)) return '';
      const isEl = isInteractive(el);
      const refStr = isEl ? ` [${assignRef(el)}]` : '';
      const role = el.getAttribute('role') || tag;
      // Use textContent rather than innerText — innerText forces a synchronous
      // layout pass per element, which is hundreds of ms on heavy pages.
      const rawName =
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.textContent?.split('\n')[0]?.trim() ||
        '';
      const nameStr = rawName
        ? rawName.length > 50
          ? ` "${rawName.substring(0, 50)}…"`
          : ` "${rawName}"`
        : '';
      let out = '';
      if (isEl || rawName) {
        out = `${'  '.repeat(depth)}<${role}${refStr}${nameStr}>\n`;
      }
      const childDepth = out ? depth + 1 : depth;
      for (let i = 0; i < el.childNodes.length; i++) {
        out += walk(el.childNodes[i], childDepth);
      }
      return out;
    };
    return { success: true, a11yTree: walk(document.body, 0) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function simulateInteractInjected(
  action: string,
  target: string,
  value: string | undefined,
): { success: boolean; error?: string } {
  try {
    let el: HTMLElement | null;
    if (target.startsWith('@e')) {
      el = document.querySelector(`[data-grove-ref="${target}"]`) as HTMLElement | null;
    } else {
      el = document.querySelector(target) as HTMLElement | null;
    }
    if (!el) return { success: false, error: `Element not found for target: ${target}` };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    switch (action) {
      case 'click': {
        el.click();
        return { success: true };
      }
      case 'dblclick': {
        el.click();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        return { success: true };
      }
      case 'fill':
      case 'type': {
        const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
        inputEl.focus();
        // React tracks input value via a wrapper around the native setter —
        // a plain `el.value = '...'` is invisible to it. Call the native
        // setter explicitly to bypass the framework wrapper.
        const proto =
          inputEl instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(inputEl, value || '');
        else inputEl.value = value || '';
        inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return { success: true };
      }
      case 'focus': {
        el.focus();
        return { success: true };
      }
      case 'hover': {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
        return { success: true };
      }
      case 'check':
      case 'uncheck': {
        const checkbox = el as HTMLInputElement;
        const wantChecked = action === 'check';
        if (checkbox.checked !== wantChecked) checkbox.click();
        return { success: true };
      }
      case 'press': {
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true, cancelable: true }));
        return { success: true };
      }
      default:
        return { success: false, error: `Unsupported interaction action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function extractContentInjected(
  extractType: string,
  target: string | undefined,
): { success: boolean; data?: unknown; error?: string; truncated?: boolean } {
  try {
    let el: HTMLElement | null = null;
    if (target) {
      if (target.startsWith('@e')) {
        el = document.querySelector(`[data-grove-ref="${target}"]`) as HTMLElement | null;
      } else {
        el = document.querySelector(target) as HTMLElement | null;
      }
    }
    // Cap extracted bodies at 1 MB — long Reddit threads or Gmail conversations
    // can return tens of MBs which choke the WS pipe back to grove and the
    // agent's context window.
    const MAX_BYTES = 1024 * 1024;
    const capped = (s: string) =>
      s.length > MAX_BYTES ? { value: s.slice(0, MAX_BYTES), truncated: true } : { value: s, truncated: false };
    switch (extractType) {
      case 'url':
        return { success: true, data: window.location.href };
      case 'title':
        return { success: true, data: document.title };
      case 'text': {
        // Use textContent rather than innerText for the same reason a11y tree
        // does — innerText forces a synchronous layout pass and on a long
        // page (huge thread, infinite feed) can block the main thread for
        // hundreds of ms. textContent walks the DOM cheaply.
        const raw = el
          ? el.textContent ?? ''
          : document.body.textContent ?? '';
        const { value, truncated } = capped(raw);
        return { success: true, data: value, truncated };
      }
      case 'html': {
        const raw = el ? el.outerHTML : document.documentElement.outerHTML;
        const { value, truncated } = capped(raw);
        return { success: true, data: value, truncated };
      }
      case 'value': {
        if (!el) return { success: false, error: 'No target element specified for value extraction' };
        const inputEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        return { success: true, data: inputEl.value };
      }
      default:
        return { success: false, error: `Unsupported extraction type: ${extractType}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ==========================================
// 🔌 Connection to Local Grove App (WebSocket)
// ==========================================
const PORT_RANGE_START = 3001;
const PORT_RANGE_END = 3010;
let activePort = 3001;
let groveWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function pingPort(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800); // 800ms quick timeout for localhost
    const resp = await fetch(`http://localhost:${port}/api/v1/auth/info`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return resp.ok;
  } catch {
    return false;
  }
}

async function findGrovePort(): Promise<number> {
  // 1. Try to read last working port from chrome.storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const data = await chrome.storage.local.get('grove_port');
    if (data.grove_port) {
      console.log(`[Grove Background] Testing cached port: ${data.grove_port}`);
      const isAlive = await pingPort(data.grove_port);
      if (isAlive) {
        activePort = data.grove_port;
        return data.grove_port;
      }
    }
  }

  // 2. Scan ports in parallel (3001 to 3010)
  console.log(`[Grove Background] Scanning ports ${PORT_RANGE_START} to ${PORT_RANGE_END}...`);
  const scanPromises: Promise<number | null>[] = [];
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    scanPromises.push(
      pingPort(port).then(isAlive => isAlive ? port : null)
    );
  }

  const results = await Promise.all(scanPromises);
  const foundPort = results.find(p => p !== null);

  if (foundPort) {
    console.log(`[Grove Background] Discovered active port: ${foundPort}`);
    activePort = foundPort;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ grove_port: foundPort });
    }
    return foundPort;
  }

  // Fallback to default
  console.log(`[Grove Background] No active server found. Falling back to port 3001.`);
  activePort = 3001;
  return 3001;
}

// In-flight guard. Without this, a triggering event arriving while a
// prior connect is still inside `await findGrovePort()` triggers a
// second connect that races the first — two `groveWs = new WebSocket(...)`
// assignments and an orphaned onclose handler scheduling a stale reconnect.
let connectInFlight = false;

async function connectToGrove() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (connectInFlight) return;
  connectInFlight = true;
  try {
    const port = await findGrovePort();
    const url = `ws://localhost:${port}/api/v1/extension/ws`;
    console.log(`[Grove Background] Connecting to ${url}`);

    const myWs = new WebSocket(url);
    groveWs = myWs;
    // All event handlers below close over `myWs` and bail out if a newer
    // connection has replaced it (`groveWs !== myWs`). Without this, a
    // late-firing handler from a closed-mid-handshake socket can stomp on
    // the new socket's state.

    myWs.onopen = () => {
      if (groveWs !== myWs) return;
      console.log(`[Grove Background] Connected to Grove Local Server on port ${port}.`);
    };

    myWs.onmessage = async (event) => {
      if (groveWs !== myWs) return;
      try {
        const msg = JSON.parse(event.data);
        console.log('[Grove Background] Message received from Grove:', msg);
        await handleGroveMessage(msg);
      } catch (e) {
        console.error('[Grove Background] Error parsing Grove message:', e);
      }
    };

    myWs.onclose = () => {
      if (groveWs !== myWs) return;
      console.log('[Grove Background] Connection to Grove lost. Retrying port discovery in 5s...');
      reconnectTimer = setTimeout(connectToGrove, 5000);
    };

    myWs.onerror = (err) => {
      if (groveWs !== myWs) return;
      console.error('[Grove Background] Grove socket error:', err);
    };
  } finally {
    connectInFlight = false;
  }
}

// Helper to manage Chrome Tab Groups based on task/project name. Scopes the
// title-match to the tab's window — otherwise a same-named group in another
// window would silently yank the new tab into that window, which is jarring.
function groupTab(tabId: number, groupName?: string): Promise<number | null> {
  if (!groupName) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      chrome.tabGroups.query({ windowId: tab.windowId }, (groups) => {
        const match = groups.find((g) => g.title === groupName);
        if (match) {
          chrome.tabs.group({ tabIds: [tabId], groupId: match.id }, () => {
            resolve(match.id);
          });
        } else {
          chrome.tabs.group({ tabIds: [tabId] }, (newGroupId) => {
            chrome.tabGroups.update(newGroupId, { title: groupName, color: 'cyan' }, () => {
              resolve(newGroupId);
            });
          });
        }
      });
    });
  });
}

// Handle inbound requests from the Grove Agent
async function handleGroveMessage(msg: any) {
  if (!groveWs || groveWs.readyState !== WebSocket.OPEN) return;

  switch (msg.type) {
    case 'GET_ALL_TABS': {
      chrome.tabs.query({}, (tabs) => {
        const tabList = tabs.map(t => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl }));
        groveWs?.send(JSON.stringify({
          type: 'ALL_TABS_RESPONSE',
          id: msg.id,
          data: tabList
        }));
      });
      break;
    }

    case 'PROXY_FETCH_TITLE': {
      const url = msg.url;
      try {
        // Limit to http(s) — file://, chrome://, chrome-extension://, ftp://
        // etc. should never round-trip through the extension's cookie jar.
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error('invalid_url');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`scheme_not_allowed: ${parsed.protocol}`);
        }

        const response = await fetch(url);
        // Cap body to 256 KB. Reading the full body of an unbounded URL
        // (huge JSON dump, infinite stream) would OOM the service worker.
        const MAX_BYTES = 256 * 1024;
        const reader = response.body?.getReader();
        let html = '';
        if (reader) {
          const decoder = new TextDecoder('utf-8');
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            html += decoder.decode(value, { stream: true });
            if (received >= MAX_BYTES) {
              await reader.cancel().catch(() => {});
              break;
            }
          }
          html += decoder.decode();
        } else {
          html = await response.text();
        }
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';

        groveWs?.send(JSON.stringify({
          type: 'PROXY_FETCH_RESPONSE',
          id: msg.id,
          data: { url, title }
        }));
      } catch (err: any) {
        console.error('[Grove Background] Proxy fetch failed:', err);
        groveWs?.send(JSON.stringify({
          type: 'PROXY_FETCH_ERROR',
          id: msg.id,
          error: err.message
        }));
      }
      break;
    }

    case 'BROWSER_OPEN': {
      const url = msg.url;
      const groupName = msg.groupName;
      chrome.tabs.create({ url }, async (tab) => {
        if (tab && tab.id) {
          // Distinguish three cases so the caller can tell apart:
          //   - groupName not requested   → groupId omitted
          //   - groupName requested, OK    → groupId: <number>
          //   - groupName requested, fail  → groupError set
          const payload: {
            success: boolean;
            tabId: number;
            groupId?: number;
            groupError?: string;
          } = { success: true, tabId: tab.id };
          if (groupName) {
            const groupId = await groupTab(tab.id, groupName);
            if (groupId !== null) {
              payload.groupId = groupId;
            } else {
              payload.groupError = 'failed to assign tab to group';
            }
          }
          groveWs?.send(JSON.stringify({
            type: 'BROWSER_OPEN_RESPONSE',
            id: msg.id,
            data: payload,
          }));
        } else {
          groveWs?.send(JSON.stringify({
            type: 'BROWSER_OPEN_RESPONSE',
            id: msg.id,
            data: { success: false, error: 'Failed to create tab' }
          }));
        }
      });
      break;
    }

    case 'BROWSER_SNAPSHOT': {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_SNAPSHOT_RESPONSE',
          id: msg.id,
          data: { success: false, error: 'tab_id required' }
        }));
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: a11yTreeInjected,
        });
        const data = results[0]?.result ?? { success: false, error: 'no_result' };
        groveWs?.send(JSON.stringify({ type: 'BROWSER_SNAPSHOT_RESPONSE', id: msg.id, data }));
      } catch (err: any) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_SNAPSHOT_RESPONSE',
          id: msg.id,
          data: { success: false, error: `inject_failed: ${err?.message ?? String(err)}` },
        }));
      }
      break;
    }

    case 'BROWSER_INTERACT': {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_INTERACT_RESPONSE',
          id: msg.id,
          data: { success: false, error: 'tab_id required' }
        }));
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: simulateInteractInjected,
          args: [msg.action, msg.target, msg.value],
        });
        const data = results[0]?.result ?? { success: false, error: 'no_result' };
        groveWs?.send(JSON.stringify({ type: 'BROWSER_INTERACT_RESPONSE', id: msg.id, data }));
      } catch (err: any) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_INTERACT_RESPONSE',
          id: msg.id,
          data: { success: false, error: `inject_failed: ${err?.message ?? String(err)}` },
        }));
      }
      break;
    }

    case 'BROWSER_EXTRACT': {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_EXTRACT_RESPONSE',
          id: msg.id,
          data: { success: false, error: 'tab_id required' }
        }));
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractContentInjected,
          args: [msg.extractType, msg.target],
        });
        const data = results[0]?.result ?? { success: false, error: 'no_result' };
        groveWs?.send(JSON.stringify({ type: 'BROWSER_EXTRACT_RESPONSE', id: msg.id, data }));
      } catch (err: any) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_EXTRACT_RESPONSE',
          id: msg.id,
          data: { success: false, error: `inject_failed: ${err?.message ?? String(err)}` },
        }));
      }
      break;
    }

    case 'BROWSER_SCREENSHOT': {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_SCREENSHOT_RESPONSE',
          id: msg.id,
          data: { success: false, error: 'tab_id required' }
        }));
        return;
      }
      // captureVisibleTab 只能截 window 内当前 active 的 tab。先 activate 目标
      // tab 再截，否则会截到用户当前看着的 tab、内容完全错位。
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          groveWs?.send(JSON.stringify({
            type: 'BROWSER_SCREENSHOT_RESPONSE',
            id: msg.id,
            data: { success: false, error: `tab_not_found: ${chrome.runtime.lastError?.message ?? tabId}` }
          }));
          return;
        }
        chrome.tabs.update(tabId, { active: true }, () => {
          if (chrome.runtime.lastError) {
            groveWs?.send(JSON.stringify({
              type: 'BROWSER_SCREENSHOT_RESPONSE',
              id: msg.id,
              data: { success: false, error: `activate_failed: ${chrome.runtime.lastError.message}` }
            }));
            return;
          }
          chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
              groveWs?.send(JSON.stringify({
                type: 'BROWSER_SCREENSHOT_RESPONSE',
                id: msg.id,
                data: { success: false, error: chrome.runtime.lastError?.message || 'Capture failed' }
              }));
            } else {
              groveWs?.send(JSON.stringify({
                type: 'BROWSER_SCREENSHOT_RESPONSE',
                id: msg.id,
                data: { success: true, screenshot: dataUrl }
              }));
            }
          });
        });
      });
      break;
    }

    default:
      console.warn('[Grove Background] Unknown message type:', msg.type);
  }
}

// Start local connection attempt on extension startup
// We try to connect, failing open if the server is not active
connectToGrove();

// MV3 service workers are aggressively suspended after ~30s idle. Without a
// wake-up source, our reconnect timer is destroyed when the SW dies and the
// WS stays disconnected until the user pokes the popup. Two safety nets:
//
//  1. `chrome.runtime.onStartup` / `onInstalled` → connect at browser boot
//     and immediately after install/upgrade.
//  2. `chrome.alarms` heartbeat every ~25s → re-runs the worker and checks
//     the WS state; reconnects if it's dropped.
chrome.runtime.onStartup.addListener(() => {
  connectToGrove();
});
chrome.runtime.onInstalled.addListener(() => {
  connectToGrove();
});
// 0.5 minute = 30s. Chrome's MV3 alarm minimum is enforced on most builds
// and at 0.4 (24s) Chrome may silently round up to 30s, putting the wake
// after the idle-kill instead of before. 0.5 lines up exactly with the
// idle limit — the alarm fires just in time to keep us alive.
chrome.alarms.create('grove-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'grove-keepalive') return;
  if (!groveWs || groveWs.readyState !== WebSocket.OPEN) {
    connectToGrove();
  }
});

// Listen for dynamic port discoveries from Content Scripts or the Popup UI.
//
// The listener is intentionally NOT declared `async` — Chrome treats a returned
// Promise inconsistently across versions, and `sendResponse` only stays valid
// when the listener returns `true`. Here we don't respond to the sender, so we
// kick off the async work in a void IIFE and return synchronously.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'GROVE_PORT_DISCOVERED') {
    void (async () => {
      const discoveredPort = message.port;
      if (discoveredPort === activePort) return;
      console.log(
        `[Grove Background] Discovered a new active port from page: ${discoveredPort}. Switching connection...`,
      );
      activePort = discoveredPort;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ grove_port: discoveredPort });
      }
      // Closing the current socket triggers onclose → connectToGrove() reads
      // the newly saved port and connects to it.
      if (groveWs) {
        groveWs.close();
      } else {
        connectToGrove();
      }
    })();
    return;
  }
});
