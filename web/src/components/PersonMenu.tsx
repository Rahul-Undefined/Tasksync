import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Task, UserProfile, UserSummary } from '@tasksync/shared';
import { ListChecks, Mail, MessageSquareShare, UserRound } from 'lucide-react';
import { get } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { navigate } from '../lib/router';
import { getState, toast, toastError } from '../lib/store';
import { useSurface } from '../lib/surface';
import { messageInTeams } from '../lib/teams';
import { Avatar, Modal, Spinner } from './ui';

// --- tiny UI state for the context menu and profile dialog -------------------
interface MenuState {
  user: UserSummary;
  x: number;
  y: number;
  task?: Task;
}
let menu: MenuState | null = null;
let profile: UserSummary | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
const subscribe = (s: () => void) => {
  subs.add(s);
  return () => subs.delete(s);
};

export function openPersonMenu(user: UserSummary, anchor: { x: number; y: number }, task?: Task) {
  menu = { user, x: anchor.x, y: anchor.y, task };
  emit();
}
export function openProfile(user: UserSummary) {
  profile = user;
  menu = null;
  emit();
}
const close = () => {
  menu = null;
  emit();
};

/** A clickable employee name that opens the Teams / Profile / Tasks context menu. */
export function PersonLink({ user, task, children }: { user: UserSummary; task?: Task; children?: React.ReactNode }) {
  const surface = useSurface();
  if (surface === 'pip') return <span style={{ fontWeight: 600 }}>{children ?? user.displayName}</span>;
  return (
    <button
      type="button"
      className="person-link"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openPersonMenu(user, { x: r.left, y: r.bottom + 6 }, task);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openPersonMenu(user, { x: e.clientX, y: e.clientY }, task);
      }}
    >
      {children ?? user.displayName}
    </button>
  );
}

function sharedTasksWith(userId: string): Task[] {
  const me = getState().me?.id;
  return [...getState().tasks.values()].filter(
    (t) =>
      (t.createdBy.id === userId || t.assignees.some((a) => a.user.id === userId && a.status === 'active')) &&
      (t.createdBy.id === me || t.assignees.some((a) => a.user.id === me && a.status === 'active')),
  );
}

export async function startTeamsMessage(user: UserSummary, task?: Task) {
  try {
    const result = await messageInTeams(user, { task, shared: task ? undefined : sharedTasksWith(user.id) });
    if (result.copied) {
      toast(
        {
          kind: 'success',
          title: 'Task image copied',
          body: `Teams is opening a chat with ${user.displayName}. Paste the image (Ctrl+V) and press Send.`,
        },
        9000,
      );
    } else {
      toast(
        {
          kind: 'info',
          title: 'Teams chat opened',
          body: 'Your browser blocked image copying, so the task image was downloaded instead. Attach it in the Teams chat.',
        },
        9000,
      );
      if (result.imageUrl) {
        const a = document.createElement('a');
        a.href = result.imageUrl;
        a.download = `tasksync-${task ? task.id.slice(0, 8) : 'summary'}.png`;
        a.click();
      }
    }
    if (!result.opened) toast({ kind: 'error', title: 'Pop-up blocked', body: 'Allow pop-ups for TaskSync to open Teams.' });
  } catch (err) {
    toastError(err, 'Could not prepare the Teams message');
  }
}

export function PersonMenuHost() {
  const m = useSyncExternalStore(subscribe, () => menu);
  const p = useSyncExternalStore(subscribe, () => profile);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 12), y: Math.min(m.y, window.innerHeight - r.height - 12) });
  }, [m]);

  useEffect(() => {
    if (!m) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [m]);

  return (
    <>
      {m && (
        <div ref={ref} className="popover floating glass glass-strong" role="menu" style={{ position: 'fixed', left: pos.x, top: pos.y, width: 270 }}>
          <div className="row" style={{ padding: '8px 10px 10px', gap: 10 }}>
            <Avatar id={m.user.id} name={m.user.displayName} />
            <div className="col" style={{ gap: 0, minWidth: 0 }}>
              <strong className="truncate">{m.user.displayName}</strong>
              <span className="tiny faint truncate">{m.user.email}</span>
            </div>
          </div>
          <div className="menu-sep" />
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              const target = m;
              close();
              void startTeamsMessage(target.user, target.task);
            }}
          >
            <MessageSquareShare size={16} /> Message in Teams
            {m.task && <span className="sub" style={{ marginLeft: 'auto' }}>with task card</span>}
          </button>
          <button className="menu-item" role="menuitem" onClick={() => openProfile(m.user)}>
            <UserRound size={16} /> View Profile
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              close();
              navigate(`/team/${m.user.id}`);
            }}
          >
            <ListChecks size={16} /> View Tasks from this Employee
          </button>
        </div>
      )}
      {p && (
        <ProfileDialog
          user={p}
          onClose={() => {
            profile = null;
            emit();
          }}
        />
      )}
    </>
  );
}

function ProfileDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const [full, setFull] = useState<(UserProfile & { online?: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<{ user: UserProfile & { online: boolean } }>(`/api/users/${user.id}`)
      .then((r) => setFull(r.user))
      .catch((e: Error) => setError(e.message));
  }, [user.id]);
  const shared = sharedTasksWith(user.id).filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length;
  return (
    <Modal
      title="Employee profile"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => (window.location.href = `mailto:${user.email}`)}>
            <Mail size={16} /> Email
          </button>
          <button
            className="btn"
            onClick={() => {
              onClose();
              navigate(`/team/${user.id}`);
            }}
          >
            <ListChecks size={16} /> Tasks
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onClose();
              void startTeamsMessage(user);
            }}
          >
            <MessageSquareShare size={16} /> Message in Teams
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 16, marginBottom: 18 }}>
        <Avatar id={user.id} name={user.displayName} size="xl" />
        <div className="col" style={{ gap: 2 }}>
          <strong style={{ fontSize: 18 }}>{user.displayName}</strong>
          <span className="muted">{full?.jobTitle ?? user.jobTitle ?? 'Omnifi employee'}</span>
          {full && (
            <span className={`conn ${full.online ? 'live' : ''}`} style={{ alignSelf: 'flex-start', marginTop: 6 }}>
              <i /> {full.online ? 'Online in TaskSync' : 'Not connected'}
            </span>
          )}
        </div>
      </div>
      {error && <div className="banner glass err">{error}</div>}
      {!full && !error && <Spinner />}
      {full && (
        <div className="kv">
          <span className="k">Email</span>
          <span className="truncate">{full.email}</span>
          <span className="k">Department</span>
          <span>{full.department ?? '—'}</span>
          <span className="k">Location</span>
          <span>{full.officeLocation ?? '—'}</span>
          <span className="k">Phone</span>
          <span>{full.phone ?? '—'}</span>
          <span className="k">Role</span>
          <span style={{ textTransform: 'capitalize' }}>{full.role}</span>
          <span className="k">Shared open tasks</span>
          <span>{shared}</span>
          <span className="k">Member since</span>
          <span>{formatDateTime(full.createdAt)}</span>
          {full.about && (
            <>
              <span className="k">About</span>
              <span>{full.about}</span>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
