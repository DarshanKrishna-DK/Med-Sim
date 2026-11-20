/** `?observe=<code>` opens the faculty observer page. Pure helper. */

const CODE_RE = /^[A-Za-z0-9_-]{6,40}\.[0-9a-f]{10}$/;

export function parseObserveCode(search: string): string | null {
  try {
    const code = new URLSearchParams(search).get('observe')?.trim() ?? '';
    return CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  }
}

export function observeCodeFromUrl(): string | null {
  return typeof window === 'undefined' ? null : parseObserveCode(window.location.search);
}
