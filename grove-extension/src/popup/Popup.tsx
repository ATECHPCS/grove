import { useState, useEffect, useRef } from 'react';
import { Radio, RefreshCw, Send, CheckCircle2, AlertCircle, XCircle } from 'lucide-react';

interface BrowserTab {
  id?: number;
  title?: string;
  url?: string;
}

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 3010;

export default function Popup() {
  const [activeTab, setActiveTab] = useState<BrowserTab | null>(null);
  const [grovePort, setGrovePort] = useState(3000);
  const [isConnected, setIsConnected] = useState(false);
  const [isScanning, setIsScanning] = useState(true);
  const [isSynced, setIsSynced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  // The extension auth token — read from `~/.grove/extension-token` on the
  // Grove side, pasted into this field by the user, then persisted to
  // chrome.storage.local. Background appends it as a query parameter when
  // opening the WS connection so the backend can validate the caller.
  const [groveToken, setGroveToken] = useState('');
  const [tokenSaved, setTokenSaved] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  // Last AUTH_ERROR / token-rejection message from background. Cleared when
  // a fresh WS connection lands.
  const [authError, setAuthError] = useState('');

  // 💻 System Light/Dark Theme matching state
  const [isDarkMode, setIsDarkMode] = useState(true);

  useEffect(() => {
    // 1. Get system prefers-color-scheme theme
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(mediaQuery.matches);
    const themeHandler = (e: MediaQueryListEvent) => setIsDarkMode(e.matches);
    mediaQuery.addEventListener('change', themeHandler);

    // 2. Query active tab info
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          setActiveTab({
            id: tabs[0].id,
            title: tabs[0].title,
            url: tabs[0].url,
          });
        }
      });
    } else {
      setActiveTab({
        title: 'Extensions',
        url: 'chrome://extensions/',
      });
    }

    // 3. Load persisted auth token + any pending AUTH_ERROR from background.
    //    The listener is captured in a local so the cleanup closure can call
    //    `removeListener` directly — no `window` round-trip needed.
    let onStorageChanged:
      | ((changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void)
      | null = null;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['grove_token', 'grove_auth_error']).then((data) => {
        if (typeof data.grove_token === 'string') {
          setGroveToken(data.grove_token);
        }
        if (typeof data.grove_auth_error === 'string' && data.grove_auth_error) {
          setAuthError(data.grove_auth_error);
        }
      });
      onStorageChanged = (changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes.grove_auth_error) {
          const next = changes.grove_auth_error.newValue;
          setAuthError(typeof next === 'string' ? next : '');
        }
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
    }

    // 4. Perform initial automatic port discovery
    autoDiscoverPort();

    return () => {
      mediaQuery.removeEventListener('change', themeHandler);
      if (
        onStorageChanged &&
        typeof chrome !== 'undefined' &&
        chrome.storage &&
        chrome.storage.onChanged
      ) {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      }
    };
  }, []);

  // 🎨 Dynamically computed HSL-tailored theme colors matching Grove Web design system
  const theme = {
    bg: isDarkMode ? '#0a0a0b' : '#fafafa', // var(--color-bg)
    bgSecondary: isDarkMode ? '#141416' : '#f4f4f5', // var(--color-bg-secondary)
    bgTertiary: isDarkMode ? '#1c1c1f' : '#e4e4e7', // var(--color-bg-tertiary)
    border: isDarkMode ? '#27272a' : '#e4e4e7', // var(--color-border)
    text: isDarkMode ? '#fafafa' : '#09090b', // var(--color-text)
    textMuted: isDarkMode ? '#71717a' : '#71717a', // var(--color-text-muted)
    highlight: '#10b981', // var(--color-highlight) emerald green
    accent: isDarkMode ? '#06b6d4' : '#0891b2', // var(--color-accent) cyan
    shadow: isDarkMode ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.05)',
    
    // Warning banner background and borders
    warningBg: isDarkMode ? 'rgba(239, 68, 68, 0.05)' : 'rgba(239, 68, 68, 0.03)',
    warningBorder: isDarkMode ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.15)',
  };

  const pingPort = async (port: number): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600); // 600ms quick timeout
      const resp = await fetch(`http://localhost:${port}/api/v1/auth/info`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return resp.ok;
    } catch {
      return false;
    }
  };

  const autoDiscoverPort = async () => {
    setIsScanning(true);
    
    // A. Read cached port from chrome.storage
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get('grove_port');
      if (data.grove_port) {
        const isAlive = await pingPort(data.grove_port);
        if (isAlive) {
          setGrovePort(data.grove_port);
          setIsConnected(true);
          setIsScanning(false);
          return;
        }
      }
    }

    // B. Scan ports 3000 to 3010 in parallel
    const scanPromises: Promise<number | null>[] = [];
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      scanPromises.push(
        pingPort(port).then(isAlive => isAlive ? port : null)
      );
    }

    const results = await Promise.all(scanPromises);
    const foundPort = results.find(p => p !== null);

    if (foundPort) {
      setGrovePort(foundPort);
      setIsConnected(true);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ grove_port: foundPort });
      }
    } else {
      setIsConnected(false);
    }
    
    setIsScanning(false);
  };

  const handleManualConnect = async () => {
    setIsConnecting(true);
    setConnectFailed(false);
    const isAlive = await pingPort(grovePort);
    
    if (isAlive) {
      setIsConnected(true);
      setConnectFailed(false);
      // Notify background service worker immediately
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({
          type: 'GROVE_PORT_DISCOVERED',
          port: grovePort
        });
      }
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ grove_port: grovePort });
      }
    } else {
      // 💥 Triggers satisfying shake animation and visual error feedback
      setIsConnected(false);
      setConnectFailed(true);
      setTimeout(() => setConnectFailed(false), 1500); // Reset feedback after 1.5s
    }
    setIsConnecting(false);
  };

  // Held across renders so a rapid double-click cancels the previous
  // "Saved → Save" reset before re-triggering it (no flicker).
  const tokenSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSaveToken = async () => {
    const trimmed = groveToken.trim();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ grove_token: trimmed });
    }
    setGroveToken(trimmed);
    setTokenSaved(true);
    if (tokenSavedTimerRef.current) clearTimeout(tokenSavedTimerRef.current);
    tokenSavedTimerRef.current = setTimeout(() => {
      setTokenSaved(false);
      tokenSavedTimerRef.current = null;
    }, 1800);
    // Background reads the token from storage on each WS reconnect — tell it
    // to bounce now so the new token takes effect.
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'GROVE_TOKEN_UPDATED' });
    }
  };

  const handleSync = async () => {
    if (!activeTab || !activeTab.url) return;
    setLoading(true);
    setSyncFailed(false);
    try {
      const resp = await fetch(`http://localhost:${grovePort}/api/v1/url/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: activeTab.url }),
      }).catch(() => null);

      if (resp && resp.ok) {
        setIsSynced(true);
        setTimeout(() => setIsSynced(false), 2000);
      } else {
        // Don't fake success — show a real error so the user knows to fix
        // their port / token before retrying.
        setSyncFailed(true);
        setTimeout(() => setSyncFailed(false), 2500);
      }
    } catch (e) {
      console.error(e);
      setSyncFailed(true);
      setTimeout(() => setSyncFailed(false), 2500);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      backgroundColor: theme.bg,
      color: theme.text,
      minHeight: '260px',
      boxSizing: 'border-box',
      transition: 'background-color 0.2s, color 0.2s',
      width: '360px'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* 🌟 Official Grove Software App Icon */}
          <img 
            src="/icons/32.png" 
            width="22" 
            height="22" 
            style={{ 
              borderRadius: '6px', 
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              border: isDarkMode ? 'none' : '1px solid rgba(0,0,0,0.08)'
            }} 
            alt="Grove Icon"
          />
          <span style={{ fontWeight: 600, fontSize: '14px', letterSpacing: '0.3px', color: theme.text }}>
            Grove Companion
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isScanning ? (
            <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite', color: theme.textMuted }} />
          ) : (
            <Radio size={10} color={isConnected ? theme.highlight : '#ef4444'} style={{ animation: isConnected ? 'pulse 2s infinite' : 'none' }} />
          )}
          <span style={{
            fontSize: '10px',
            color: isScanning ? theme.textMuted : isConnected ? theme.highlight : '#ef4444',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }}>
            {isScanning ? 'Scanning' : isConnected ? 'Connected' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Main Body */}
      {isScanning ? (
        // 🌀 Scanning state card
        <div style={{
          background: theme.bgSecondary,
          border: `1px solid ${theme.border}`,
          borderRadius: '10px',
          padding: '24px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px'
        }}>
          <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', color: theme.highlight }} />
          <div style={{ fontSize: '12px', color: theme.textMuted, textAlign: 'center' }}>
            Exploring active local ports...
          </div>
        </div>
      ) : !isConnected ? (
        // ⚠️ Offline / Not Connected Card
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{
            background: theme.warningBg,
            border: `1px solid ${theme.warningBorder}`,
            borderRadius: '10px',
            padding: '14px 12px',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start'
          }}>
            <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: theme.text }}>
                Grove is not running or connected
              </span>
              <span style={{ fontSize: '11px', color: theme.textMuted, lineHeight: '1.4' }}>
                Make sure your Grove desktop app is open, or verify the port below if using a custom startup port.
              </span>
            </div>
          </div>

          {/* Port input card (with shake animation on error) */}
          <div style={{
            background: theme.bgSecondary,
            border: `1px solid ${theme.border}`,
            borderRadius: '10px',
            padding: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            animation: connectFailed ? 'shake 0.35s ease-in-out' : 'none'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                Custom Port
              </span>
              <span style={{ fontSize: '10px', color: theme.textMuted }}>
                e.g. 8888, 5000
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="number"
                value={grovePort}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) setGrovePort(val);
                }}
                className="hide-arrows"
                style={{
                  width: '64px',
                  background: theme.bg,
                  border: `1px solid ${theme.border}`,
                  borderRadius: '6px',
                  padding: '5px 8px',
                  color: theme.text,
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  textAlign: 'center',
                  outline: 'none',
                  transition: 'border-color 0.2s',
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.1)'
                }}
                onFocus={(e) => e.currentTarget.style.borderColor = theme.accent}
                onBlur={(e) => e.currentTarget.style.borderColor = theme.border}
              />
              <button
                onClick={handleManualConnect}
                disabled={isConnecting}
                style={{
                  background: isConnecting 
                    ? theme.bgTertiary 
                    : connectFailed 
                    ? 'rgba(239, 68, 68, 0.1)' 
                    : 'transparent',
                  border: `1px solid ${connectFailed ? '#ef4444' : theme.border}`,
                  borderRadius: '6px',
                  padding: '5px 12px',
                  color: connectFailed ? '#ef4444' : theme.text,
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  transition: 'all 0.15s',
                  minWidth: '78px',
                  justifyContent: 'center'
                }}
                onMouseEnter={(e) => {
                  if (!connectFailed) {
                    e.currentTarget.style.borderColor = theme.textMuted;
                    e.currentTarget.style.backgroundColor = theme.bgTertiary;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!connectFailed) {
                    e.currentTarget.style.borderColor = theme.border;
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                {isConnecting ? (
                  <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
                ) : connectFailed ? (
                  <>
                    <XCircle size={11} />
                    <span>Failed</span>
                  </>
                ) : (
                  'Connect'
                )}
              </button>
            </div>
          </div>
        </div>
      ) : (
        // 🎉 Connected State
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Active browser tab card */}
          <div style={{
            background: theme.bgSecondary,
            border: `1px solid ${theme.border}`,
            borderRadius: '10px',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', color: theme.textMuted, fontWeight: 600, letterSpacing: '0.5px' }}>
              Active Browser Tab
            </div>
            {activeTab ? (
              <div>
                <div style={{
                  fontWeight: 500,
                  fontSize: '12px',
                  color: theme.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginBottom: '2px'
                }}>
                  {activeTab.title || 'Untitled Page'}
                </div>
                <div style={{
                  fontSize: '10px',
                  color: theme.accent,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'monospace'
                }}>
                  {activeTab.url || 'No URL'}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: theme.textMuted }}>Retrieving tab state...</div>
            )}
          </div>

          {/* Connected Port Details */}
          <div style={{
            background: theme.bgSecondary,
            border: `1px solid ${theme.border}`,
            borderRadius: '10px',
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <CheckCircle2 size={12} color={theme.highlight} />
              <span style={{ fontSize: '11px', color: theme.text, fontWeight: 500 }}>
                Synced with port <span style={{ fontFamily: 'monospace', color: theme.accent }}>{grovePort}</span>
              </span>
            </div>
            <button
              onClick={() => {
                setIsConnected(false);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.textMuted,
                fontSize: '10px',
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: 0
              }}
            >
              Change port
            </button>
          </div>

          {/* Sync Button */}
          <button
            onClick={handleSync}
            disabled={loading}
            style={{
              background: syncFailed ? 'rgba(239, 68, 68, 0.1)' : theme.highlight,
              border: syncFailed ? '1px solid #ef4444' : 'none',
              borderRadius: '8px',
              padding: '10px',
              color: syncFailed ? '#ef4444' : isDarkMode ? '#0a0a0b' : '#fafafa',
              fontWeight: 600,
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              transition: 'all 0.15s',
              boxShadow: syncFailed ? 'none' : `0 2px 10px ${isDarkMode ? 'rgba(16, 185, 129, 0.15)' : 'rgba(16, 185, 129, 0.1)'}`
            }}
            onMouseEnter={(e) => {
              if (!isSynced && !syncFailed) e.currentTarget.style.filter = 'brightness(1.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'brightness(1)';
            }}
          >
            {loading ? (
              <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
            ) : isSynced ? (
              <>
                <CheckCircle2 size={12} />
                <span>Synced Successfully!</span>
              </>
            ) : syncFailed ? (
              <>
                <XCircle size={12} />
                <span>Sync Failed</span>
              </>
            ) : (
              <>
                <Send size={12} />
                <span>Sync Page to Grove</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Auth Token — required by Grove to accept this extension's WS
          connection. User reads it from ~/.grove/extension-token on the Grove
          side and pastes it here once. */}
      <div style={{
        background: theme.bgSecondary,
        border: `1px solid ${theme.border}`,
        borderRadius: '10px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ fontSize: '11px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
            Auth Token
          </span>
          <span style={{ fontSize: '10px', color: theme.textMuted }}>
            Paste from <code style={{ fontFamily: 'monospace' }}>~/.grove/extension-token</code>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="password"
            value={groveToken}
            onChange={(e) => setGroveToken(e.target.value)}
            placeholder="32-char hex"
            style={{
              flex: 1,
              minWidth: 0,
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: '6px',
              padding: '5px 8px',
              color: theme.text,
              fontFamily: 'monospace',
              fontSize: '12px',
              outline: 'none',
              boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.1)',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = theme.accent)}
            onBlur={(e) => (e.currentTarget.style.borderColor = theme.border)}
          />
          <button
            onClick={handleSaveToken}
            style={{
              background: tokenSaved ? 'rgba(16, 185, 129, 0.1)' : 'transparent',
              border: `1px solid ${tokenSaved ? '#10b981' : theme.border}`,
              borderRadius: '6px',
              padding: '5px 12px',
              color: tokenSaved ? '#10b981' : theme.text,
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s',
              minWidth: '64px',
            }}
          >
            {tokenSaved ? 'Saved' : 'Save'}
          </button>
        </div>
        {authError && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: '6px',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              color: '#ef4444',
              fontSize: '11px',
              lineHeight: 1.4,
            }}
          >
            {authError}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '10px',
        color: theme.textMuted,
        borderTop: `1px solid ${theme.border}`,
        paddingTop: '10px',
        marginTop: 'auto'
      }}>
        <span>Grove Companion v1.0.0</span>
        <button
          onClick={autoDiscoverPort}
          disabled={isScanning}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.accent,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '10px',
            padding: 0
          }}
        >
          <RefreshCw size={10} /> Scan ports
        </button>
      </div>

      {/* ⚡ Custom CSS injects for smooth micro-animations and clean layouts */}
      <style>{`
        /* Hide number input native spinners */
        .hide-arrows::-webkit-outer-spin-button,
        .hide-arrows::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .hide-arrows {
          -moz-appearance: textfield;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        
        /* 💥 High-satisfaction shake micro-animation for failed connections */
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20%, 60% { transform: translateX(-4px); }
          40%, 80% { transform: translateX(4px); }
        }
      `}</style>
    </div>
  );
}
