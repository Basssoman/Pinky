// On the deal page (deal made from a request): "the profile
// key / contact changed N days ago" for 14 days, and "support is changing the
// key of this profile" while a reset is pending. Read from the
// public profile; nothing is shown when it cannot be read.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { RecentChange } from '../lib/market';
import { market } from './ctx';

export function ProfileChangeNote({ profileId }: { profileId?: string }) {
  const tl = useT().market.life;
  const [state, setState] = useState<{ change: RecentChange | null; changing: boolean } | null>(null);
  useEffect(() => {
    if (!profileId) return;
    let alive = true;
    market()
      .then((api) => api.profile(profileId))
      .then((p) => alive && setState({ change: p.recent_change ?? null, changing: !!p.key_changing }))
      .catch(() => {
        /* no note when the profile cannot be read */
      });
    return () => {
      alive = false;
    };
  }, [profileId]);
  if (!state || (!state.change && !state.changing)) return null;
  return (
    <p className="hint mk-note" role="note">
      {state.changing && tl.keyChanging} {state.change && tl.changed(state.change.what, state.change.days_ago)}
    </p>
  );
}
