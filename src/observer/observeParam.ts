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

const FAC_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** `&fac=<token>`: this observer was invited as faculty by phone and may decide
 *  on held drugs (POST /agent/room/guest/{token}/act). Pure helper. */
export function parseFacultyToken(search: string): string | null {
  try {
    const t = new URLSearchParams(search).get('fac')?.trim() ?? '';
    return FAC_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function facultyTokenFromUrl(): string | null {
  return typeof window === 'undefined' ? null : parseFacultyToken(window.location.search);
}
