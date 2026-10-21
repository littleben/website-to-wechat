// Detect WeChat's in-app browser and remember where the visitor was before they
// leave to message the official account (the one-tap link opens a new page).

export const isWechatBrowser = () =>
  typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent);

export const isMobile = () =>
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/** 'desktop' → QR + pairing code; 'mobile' → copy code & open WeChat; 'wechat' → keyword + one-tap link */
export function loginSurface(): 'desktop' | 'mobile' | 'wechat' {
  if (isWechatBrowser()) return 'wechat';
  return isMobile() ? 'mobile' : 'desktop';
}

const RETURN_COOKIE = 'wx_return';

/** Only same-site paths; never a full URL (open redirect). */
function safePath(path: string | null | undefined) {
  if (!path || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) return null;
  return path;
}

export function rememberLoginReturn(path = location.pathname + location.search) {
  const safe = safePath(path);
  if (!safe) return;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${RETURN_COOKIE}=${encodeURIComponent(safe)}; Max-Age=1800; Path=/; SameSite=Lax${secure}`;
}

export function takeLoginReturn(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${RETURN_COOKIE}=([^;]*)`));
  document.cookie = `${RETURN_COOKIE}=; Max-Age=0; Path=/`;
  if (!match) return null;
  try { return safePath(decodeURIComponent(match[1])); } catch { return null; }
}

/** Copy the pairing code, then try to open WeChat. Copy first: the jump may unload the page. */
export async function copyCodeAndOpenWechat(code: string) {
  try { await navigator.clipboard.writeText(code); } catch { /* show the code for manual copy */ }
  location.href = 'weixin://';
}

/**
 * Poll the pairing endpoint until it signs in or expires.
 * Some mobile browsers never fire visibilitychange on return, so keep polling in the background, slower.
 */
export function pollPairing(claim: () => Promise<{ status: string }>, onDone: (status: string) => void) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const { status } = await claim();
      if (status !== 'pending') { stopped = true; onDone(status); return; }
    } catch { /* transient network error: keep polling */ }
    setTimeout(tick, document.hidden ? 6000 : 2000);
  };
  tick();
  return () => { stopped = true; };
}
