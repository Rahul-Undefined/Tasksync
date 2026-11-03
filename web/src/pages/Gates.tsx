import { useState, type ReactNode } from 'react';
import type { UserProfile } from '@tasksync/shared';
import { AlertTriangle, Check, Clock, LogOut, RefreshCw, ShieldAlert, Wrench } from 'lucide-react';
import { Spinner } from '../components/ui';
import type { AuthClient, ClientConfig } from '../lib/auth';
import { errorMessage } from '../lib/api';

function Mark() {
  return (
    <div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 18 }}>
      <Check size={30} strokeWidth={3.2} color="#fff" />
    </div>
  );
}

function Hero({ children }: { children: ReactNode }) {
  return (
    <div className="center-screen">
      <div className="hero glass glass-strong">{children}</div>
    </div>
  );
}

export function LoadingScreen({ waking, label = 'Loading TaskSync…' }: { waking?: boolean; label?: string }) {
  return (
    <Hero>
      <Mark />
      <Spinner />
      <div className="muted">{waking ? 'Waking up the TaskSync server. This can take up to a minute after a quiet period…' : label}</div>
    </Hero>
  );
}

const MicrosoftLogo = () => (
  <span className="ms-logo" aria-hidden="true">
    <i style={{ background: '#f25022' }} />
    <i style={{ background: '#7fba00' }} />
    <i style={{ background: '#00a4ef' }} />
    <i style={{ background: '#ffb900' }} />
  </span>
);

// Fictional identities for local development only (the API refuses dev sign-in in production).
const DEV_PEOPLE = [
  { local: 'dev.admin', name: 'Dev Admin', note: 'Bootstrap administrator' },
  { local: 'alex.morgan', name: 'Alex Morgan', note: 'Employee' },
  { local: 'sam.patel', name: 'Sam Patel', note: 'Employee' },
  { local: 'jordan.lee', name: 'Jordan Lee', note: 'Employee' },
];

export function SignInScreen({ auth, config, error }: { auth: AuthClient; config: ClientConfig; error?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(error ?? null);
  const domain = config.allowedDomains[0] ?? 'myomnifi.com';
  const go = async (opts?: { email: string; name: string }) => {
    setBusy(true);
    setErr(null);
    try {
      await auth.signIn(opts);
      if (auth.mode === 'dev') window.location.reload();
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Hero>
      <Mark />
      <div>
        <h1>TaskSync</h1>
        <p className="tagline">Create once. Assign once. Synchronise everywhere.</p>
      </div>
      {auth.mode === 'entra' ? (
        <>
          <button className="btn btn-lg" style={{ width: '100%', background: '#fff', color: '#1b1b1b', borderColor: '#fff' }} onClick={() => go()} disabled={busy}>
            {busy ? <Spinner /> : <MicrosoftLogo />} Sign in with Microsoft
          </button>
          <p className="faint small" style={{ margin: 0 }}>
            Use your <strong>@{domain}</strong> work account. Personal and external accounts are not accepted. New users need administrator approval.
          </p>
        </>
      ) : (
        <>
          <div className="banner glass warn" style={{ textAlign: 'left' }}>
            <Wrench size={16} /> Local development sign-in. Microsoft Entra ID is not configured on this server.
          </div>
          <div className="col" style={{ width: '100%', gap: 6 }}>
            {DEV_PEOPLE.map((p) => (
              <button key={p.local} className="menu-item glass" style={{ padding: 10 }} disabled={busy} onClick={() => go({ email: `${p.local}@${domain}`, name: p.name })}>
                <span className="col" style={{ gap: 0 }}>
                  <strong>{p.name}</strong>
                  <span className="sub">{`${p.local}@${domain}`} · {p.note}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {err && <div className="banner glass err" style={{ width: '100%', textAlign: 'left' }}>{err}</div>}
    </Hero>
  );
}

export function AccessScreen({ me, onRefresh, onSignOut }: { me: UserProfile; onRefresh: () => void; onSignOut: () => void }) {
  const copy = {
    pending: {
      icon: <Clock size={28} />,
      title: 'Waiting for approval',
      body: `You're signed in as ${me.email}. A TaskSync administrator has been notified and needs to approve your access. This page updates automatically when they do.`,
    },
    rejected: {
      icon: <ShieldAlert size={28} />,
      title: 'Access not approved',
      body: 'An administrator did not approve TaskSync access for this account. Contact your manager or IT if you think this is a mistake.',
    },
    deactivated: {
      icon: <ShieldAlert size={28} />,
      title: 'Access deactivated',
      body: 'Your TaskSync access has been deactivated. Contact an administrator if you need it restored.',
    },
    approved: { icon: <Check size={28} />, title: 'Approved', body: '' },
  }[me.status];
  return (
    <Hero>
      <div className="empty" style={{ padding: 0 }}>
        <div className="icon">{copy.icon}</div>
      </div>
      <div>
        <h1 style={{ fontSize: 24 }}>{copy.title}</h1>
        <p className="tagline" style={{ marginTop: 10 }}>{copy.body}</p>
      </div>
      <div className="row">
        <button className="btn" onClick={onRefresh}>
          <RefreshCw size={15} /> Check again
        </button>
        <button className="btn btn-ghost" onClick={onSignOut}>
          <LogOut size={15} /> Sign out
        </button>
      </div>
    </Hero>
  );
}

export function SetupScreen({ config }: { config: ClientConfig | null }) {
  return (
    <Hero>
      <div className="empty" style={{ padding: 0 }}>
        <div className="icon">
          <Wrench size={26} />
        </div>
      </div>
      <h1 style={{ fontSize: 24 }}>TaskSync is almost ready</h1>
      <p className="tagline">The server is running but still needs its one-time configuration.</p>
      <div className="col" style={{ width: '100%', textAlign: 'left', gap: 8 }}>
        <div className={`banner glass ${config?.databaseConfigured ? '' : 'warn'}`}>
          {config?.databaseConfigured ? <Check size={16} /> : <AlertTriangle size={16} />} Data storage (private GitHub repository)
        </div>
        <div className={`banner glass ${config?.authMode === 'not_configured' ? 'warn' : ''}`}>
          {config?.authMode === 'not_configured' ? <AlertTriangle size={16} /> : <Check size={16} />} Microsoft Entra ID sign-in
        </div>
      </div>
      <p className="faint small" style={{ margin: 0 }}>An administrator should follow DEPLOYMENT_GUIDE.md in the TaskSync repository.</p>
    </Hero>
  );
}

export function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Hero>
      <div className="empty" style={{ padding: 0 }}>
        <div className="icon">
          <AlertTriangle size={26} />
        </div>
      </div>
      <h1 style={{ fontSize: 22 }}>Can't reach TaskSync</h1>
      <p className="tagline">{message}</p>
      <button className="btn btn-primary" onClick={onRetry}>
        <RefreshCw size={15} /> Try again
      </button>
    </Hero>
  );
}
