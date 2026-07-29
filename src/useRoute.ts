import { useEffect, useState } from 'react';

export type Route = { name: 'portfolio' } | { name: 'project'; projectId: string; focus: string | null };

export function parseRoute(hash: string): Route {
  const value = hash.replace(/^#/, '') || '/';
  const [path, query = ''] = value.split('?');
  const match = path.match(/^\/projects\/([^/]+)$/);
  if (!match) return { name: 'portfolio' };
  return {
    name: 'project',
    projectId: decodeURIComponent(match[1]),
    focus: new URLSearchParams(query).get('focus'),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return route;
}
