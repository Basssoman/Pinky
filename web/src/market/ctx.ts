// The marketplace API every market page uses, and this browser's profile key.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { NET } from '../lib/config';
import { loadProfileKey, onProfileKeyChange, type ProfileKey } from '../lib/market';
import { httpMarketApi, type MarketApi } from '../lib/marketApi';

let api: Promise<MarketApi> | null = null;

/** Dev server started with `npm run dev:mock`: the stand-in API (never in a production build). */
export const MOCK = import.meta.env.DEV && import.meta.env.MODE === 'mock';

export function market(): Promise<MarketApi> {
  if (!api) {
    api =
      import.meta.env.DEV && import.meta.env.MODE === 'mock'
        ? import('../dev/marketMock').then((m) => m.mockMarketApi())
        : Promise.resolve(httpMarketApi(NET.apiBase));
  }
  return api;
}

let ready: MarketApi | null = null;
void market().then((a) => {
  ready = a;
});

/** Where a profile picture is served: always our own API. Empty = not available (the pixel pattern shows). */
export function avatarUrl(profileId: string, version: string): string {
  return (ready ?? httpMarketApi(NET.apiBase)).avatarUrl(profileId, version);
}

let cached: ProfileKey | null | undefined;
const read = () => {
  if (cached === undefined) cached = loadProfileKey();
  return cached;
};
onProfileKeyChange(() => {
  cached = loadProfileKey();
});

/** This browser's profile key (null = none); re-renders when it changes. */
export function useProfileKey(): ProfileKey | null {
  return useSyncExternalStore(onProfileKeyChange, read, read);
}

/** Loads something from the marketplace API; `reload` reads it again. */
export function useMarket<T>(load: (api: MarketApi) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    market()
      .then(load)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      // a failed reload keeps what is on screen
      .catch((error) => alive && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
