/**
 * Logger utility that's silent in production builds.
 * Uses Vite's import.meta.env.PROD to detect production mode.
 *
 * Enable in production via:
 * - URL param: ?debug=true
 * - Console: localStorage.setItem('dialtone-debug', 'true'); location.reload();
 * - Console: window.enableDialtoneDebug()
 */

const isDev = !import.meta.env.PROD;

// Check for debug override in production
function isDebugEnabled(): boolean {
  if (isDev) return true;

  // In Web Workers, check for global debug flag
  if (typeof window === 'undefined') {
    // Workers: check global scope for debug flag
    try {
      return !!(globalThis as any).__DIALTONE_DEBUG__;
    } catch {
      return false;
    }
  }

  // Main thread: check URL param
  const params = new URLSearchParams(window.location.search);
  if (params.get('debug') === 'true') return true;

  // Check localStorage
  try {
    if (localStorage.getItem('dialtone-debug') === 'true') return true;
  } catch {
    // localStorage not available
  }

  // Check runtime flag
  if ((window as any).__DIALTONE_DEBUG__) return true;

  return false;
}

// Cache the initial value, but allow dynamic re-checking
let debugEnabled = isDebugEnabled();

// Re-check debug status (for workers where flag is set after module load)
function checkDebugEnabled(): boolean {
  if (debugEnabled) return true;
  // Re-evaluate in case flag was set after module load
  debugEnabled = isDebugEnabled();
  return debugEnabled;
}

// Expose function to enable debug at runtime
if (typeof window !== 'undefined') {
  (window as any).enableDialtoneDebug = () => {
    debugEnabled = true;
    localStorage.setItem('dialtone-debug', 'true');
    console.log('[Dialtone] Debug logging enabled. Refresh for full effect.');
  };
  (window as any).disableDialtoneDebug = () => {
    debugEnabled = false;
    localStorage.removeItem('dialtone-debug');
    console.log('[Dialtone] Debug logging disabled.');
  };
}

export const logger = {
  log: (...args: unknown[]) => {
    if (checkDebugEnabled()) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (checkDebugEnabled()) console.warn(...args);
  },
  info: (...args: unknown[]) => {
    if (checkDebugEnabled()) console.info(...args);
  },
  debug: (...args: unknown[]) => {
    if (checkDebugEnabled()) console.debug(...args);
  },
  // Errors always log, even in production
  error: (...args: unknown[]) => {
    console.error(...args);
  },
};
