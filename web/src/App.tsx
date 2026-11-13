// Routes. Real pages go by path: `/new` (creator), `/d#<token>` (the deal,
// both sides), `/k#<key>` (personal link), `/status`, `/disputes`; the
// marketplace: `/creators`, `/creators/<id>`, `/creators/<id>/order`,
// `/profile`, `/p#<recovery>`, `/inbox`, `/r#<request token>`. The home
// page and the example deal (`?step=`, made-up data) need no server.
import { useEffect, useState } from 'react';
import { Demo, DEMO_STEPS, type DemoStep } from './demo/Demo';
import { useT } from './i18n';
import { Landing } from './Landing';
import { parseClientLink } from './lib/local';
import { navigate } from './real/ctx';
import { DealRoute } from './real/DealRoute';
import { DisputesPage, KeyLink, NewDeal, StatusPage } from './real/pages';
import { Shell } from './Shell';
import { Notice } from './ui';
import { Catalog } from './market/Catalog';
import { EditorPage, RecoveryLinkPage } from './market/Editor';
import { InboxPage } from './market/Inbox';
import { OrderPage } from './market/OrderPage';
import { ProfilePage } from './market/ProfilePage';
import { BadRequestLink, RequestPage } from './market/RequestPage';
import { isProfileId, parseRequestLink } from './lib/market';

function readLocation() {
  const step = new URLSearchParams(window.location.search).get('step');
  return {
    path: window.location.pathname.replace(/\/+$/, '') || '/',
    hash: window.location.hash,
    step: DEMO_STEPS.includes(step as DemoStep) ? (step as DemoStep) : null,
  };
}

/** Example-deal steps anyone may open; the rest of the demo is for development. */
const PUBLIC_DEMO: DemoStep[] = ['terms', 'key', 'pay', 'deal'];

export function App() {
  const [loc, setLoc] = useState(readLocation);
  const t = useT();

  useEffect(() => {
    const update = () => setLoc(readLocation());
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);

  const page = () => {
    switch (loc.path) {
      case '/new':
        return <NewDeal />;
      case '/d': {
        const token = parseClientLink(loc.hash);
        return token ? (
          <DealRoute key={token} token={token} />
        ) : (
          <Notice title={t.notice.linkIncomplete} lines={[t.notice.linkIncompleteLine]} />
        );
      }
      case '/k':
        return <KeyLink key={loc.hash} />;
      case '/status':
        return <StatusPage />;
      case '/disputes':
        return <DisputesPage />;
      // marketplace
      case '/creators':
        return <Catalog />;
      case '/profile':
        return <EditorPage />;
      case '/p':
        return <RecoveryLinkPage key={loc.hash} />;
      case '/inbox':
        return <InboxPage />;
      case '/r': {
        const token = parseRequestLink(loc.hash);
        return token ? <RequestPage key={token} token={token} /> : <BadRequestLink />;
      }
    }
    const creator = /^\/creators\/([0-9a-f]+)(\/order)?$/.exec(loc.path);
    if (creator && isProfileId(creator[1])) {
      return creator[2] ? <OrderPage key={creator[1]} id={creator[1]} /> : <ProfilePage key={creator[1]} id={creator[1]} />;
    }
    if (loc.step && (import.meta.env.DEV || PUBLIC_DEMO.includes(loc.step))) {
      return <Demo step={loc.step} go={(next) => navigate(next === 'home' ? '/' : `/?step=${next}`)} />;
    }
    return <Home />;
  };

  const home = loc.path === '/' && !loc.step;
  return <Shell bleed={home}>{home ? <Home /> : page()}</Shell>;
}

function Home() {
  const title = useT().titles.home;
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    // The unfinished-deal reminder lives only on "Create a deal" (/new), not on the home.
    <Landing onCreate={() => navigate('/new')} onExample={() => navigate('/?step=terms')} />
  );
}
