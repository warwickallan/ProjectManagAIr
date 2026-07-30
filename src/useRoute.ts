import { useEffect, useState } from 'react';

export type Route =
  | { name: 'today' }
  | { name: 'inbox' }
  | { name: 'calendar' }
  | { name: 'portfolio' }
  | { name: 'needs-you' }
  | { name: 'ai-chat' }
  | { name: 'settings' }
  | { name: 'project'; projectId: string; tab: string | null };

export function parseRoute(hash: string): Route {
  const value = hash.replace(/^#/, '') || '/today';
  const [path, query = ''] = value.split('?');
  if (path === '/' || path === '/today') return { name: 'today' };
  if (path === '/inbox') return { name: 'inbox' };
  if (path === '/calendar') return { name: 'calendar' };
  if (path === '/projects') return { name: 'portfolio' };
  if (path === '/settings') return { name: 'settings' };
  if (path === '/needs-you') return { name: 'needs-you' };
  if (path === '/ai-chat') return { name: 'ai-chat' };
  const match = path.match(/^\/projects\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return { name: 'today' };
  return {
    name: 'project',
    projectId: decodeURIComponent(match[1]),
    tab: match[2] ? decodeURIComponent(match[2]) : new URLSearchParams(query).get('focus'),
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
