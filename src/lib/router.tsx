import { type AnchorHTMLAttributes, type MouseEvent, useCallback, useSyncExternalStore } from 'react';

// A very small router: the app has three pages and keeps its filters in the query string,
// so every view is a deep link.

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener('theia:navigate', onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('theia:navigate', onChange);
  };
}

export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
  const i = href.indexOf('?');
  return i === -1 ? { pathname: href, search: '' } : { pathname: href.slice(0, i), search: href.slice(i) };
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search) return;
  if (opts.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('theia:navigate'));
}

/** Reads and writes query parameters, preserving the others. */
export function useQueryParams(): [URLSearchParams, (changes: Record<string, string | null>, opts?: { replace?: boolean }) => void] {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const set = useCallback(
    (changes: Record<string, string | null>, opts: { replace?: boolean } = {}) => {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      navigate(qs ? `${pathname}?${qs}` : pathname, opts);
    },
    [pathname],
  );
  return [params, set];
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
