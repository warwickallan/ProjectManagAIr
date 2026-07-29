import { useEffect, useState } from 'react';
import type { buildPortfolioResponse, buildProjectResponse } from './domain';

export type PortfolioResponse = ReturnType<typeof buildPortfolioResponse>;
export type ProjectResponse = NonNullable<ReturnType<typeof buildProjectResponse>>;

type ApiState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: string };

export function useApi<T>(url: string): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ status: 'loading', data: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });
    fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed with status ${response.status}`);
        }
        return response.json() as Promise<T>;
      })
      .then((data) => setState({ status: 'success', data, error: null }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'error', data: null, error: error instanceof Error ? error.message : 'Unknown error' });
      });
    return () => controller.abort();
  }, [url]);

  return state;
}
