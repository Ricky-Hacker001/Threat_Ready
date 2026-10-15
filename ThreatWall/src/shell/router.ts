import { useEffect, useState } from 'react';
import { DEFAULT_ROUTE, routeFor } from './nav';

const read = () => {
  const p = window.location.hash.replace(/^#\/?/, '');
  return routeFor(p) ? p : DEFAULT_ROUTE;
};

export function useRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(read);
  useEffect(() => {
    const on = () => setPath(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (p: string) => { window.location.hash = `/${p}`; };
  return [path, go];
}
