import { useCallback, useEffect, useState } from 'react';
import type { UserProfile, UserStatus } from '@tasksync/shared';
import { Check, RotateCcw, ShieldCheck, ShieldOff, UserX, X } from 'lucide-react';
import { Avatar, Empty, Modal, Spinner } from '../components/ui';
import { get, post } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { toast, toastError, useStore } from '../lib/store';

interface AuditEntry {
  id: number;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  data: Record<string, unknown>;
  actor: string | null;
  createdAt: string;
}

type Tab = 'pending' | 'users' | 'audit';

export function AdminPage() {
  const me = useStore((s) => s.me)!;
  const [tab, setTab] = useState<Tab>('pending');
  const [users, setUsers] = useState<UserProfile[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [confirm, setConfirm] = useState<{ user: UserProfile; action: 'reject' | 'deactivate' } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await get<{ users: UserProfile[] }>('/api/admin/users');
      setUsers(res.users);
    } catch (err) {
      toastError(err, 'Could not load users');
    }
  }, []);
  useEffect(() => {
    void load();
    const onUpdate = () => void load();
    window.addEventListener('tasksync:users-changed', onUpdate);
    return () => window.removeEventListener('tasksync:users-changed', onUpdate);
  }, [load]);
  useEffect(() => {
    if (tab === 'audit') get<{ entries: AuditEntry[] }>('/api/admin/audit').then((r) => setAudit(r.entries), (e) => toastError(e));
  }, [tab]);

  const act = async (user: UserProfile, action: string, body: Record<string, unknown> = {}) => {
    try {
      const path = action === 'role' ? `/api/admin/users/${user.id}/role` : `/api/admin/users/${user.id}/${action}`;
      await post(path, body);
      const done: Record<string, string> = { approve: 'approved', reject: 'rejected', deactivate: 'deactivated', reactivate: 'reactivated' };
      toast({ kind: 'success', title: `${user.displayName}: ${action === 'role' ? `now ${String(body.role)}` : done[action]}` }, 3000);
      await load();
    } catch (err) {
      toastError(err);
    }
  };

  const pending = users?.filter((u) => u.status === 'pending') ?? [];
  const statusColor: Record<UserStatus, string> = { pending: 's-declined', approved: 's-completed', rejected: 's-cancelled', deactivated: 's-pending' };

  return (
    <div className="content-inner">
      <div className="row">
        <div className="tabs" role="tablist">
          <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
            Access requests · {pending.length}
          </button>
          <button className={`tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>
            All users · {users?.length ?? 0}
          </button>
          <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
            Audit log
          </button>
        </div>
      </div>

      {!users ? (
        <Spinner />
      ) : tab === 'pending' ? (
        pending.length === 0 ? (
          <Empty icon={<ShieldCheck size={24} />} title="No pending requests">
            When a colleague signs in with their Omnifi Microsoft account for the first time, their request appears here for approval.
          </Empty>
        ) : (
          <div className="task-list">
            {pending.map((u) => (
              <div key={u.id} className="glass row wrap" style={{ padding: 16, gap: 14 }}>
                <Avatar id={u.id} name={u.displayName} size="lg" />
                <div className="col" style={{ gap: 0, flex: 1, minWidth: 200 }}>
                  <strong>{u.displayName}</strong>
                  <span className="small muted">{u.email}</span>
                  <span className="tiny faint">Requested {relativeTime(u.createdAt)} · verified Omnifi Microsoft account</span>
                </div>
                <button className="btn btn-danger" onClick={() => setConfirm({ user: u, action: 'reject' })}>
                  <X size={15} /> Reject
                </button>
                <button className="btn btn-primary" onClick={() => act(u, 'approve')}>
                  <Check size={15} /> Approve
                </button>
              </div>
            ))}
          </div>
        )
      ) : tab === 'users' ? (
        <div className="glass" style={{ padding: 6, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Status</th>
                <th>Role</th>
                <th className="hide-mobile">Last sign-in</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="row" style={{ gap: 10 }}>
                      <Avatar id={u.id} name={u.displayName} />
                      <div className="col" style={{ gap: 0, minWidth: 0 }}>
                        <span className="truncate">{u.displayName}{u.id === me.id ? ' (you)' : ''}</span>
                        <span className="tiny faint truncate">{u.email}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${statusColor[u.status]}`} style={{ textTransform: 'capitalize' }}>{u.status}</span>
                  </td>
                  <td style={{ textTransform: 'capitalize' }}>{u.role}</td>
                  <td className="hide-mobile faint">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : '—'}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      {(u.status === 'pending' || u.status === 'rejected') && (
                        <button className="btn btn-sm" onClick={() => act(u, 'approve')}>
                          <Check size={13} /> Approve
                        </button>
                      )}
                      {u.status === 'approved' && u.id !== me.id && (
                        <button className="btn btn-sm" onClick={() => act(u, 'role', { role: u.role === 'admin' ? 'employee' : 'admin' })}>
                          {u.role === 'admin' ? <ShieldOff size={13} /> : <ShieldCheck size={13} />} {u.role === 'admin' ? 'Make employee' : 'Make admin'}
                        </button>
                      )}
                      {u.status === 'approved' && u.id !== me.id && (
                        <button className="btn btn-sm btn-danger" onClick={() => setConfirm({ user: u, action: 'deactivate' })}>
                          <UserX size={13} /> Deactivate
                        </button>
                      )}
                      {u.status === 'deactivated' && (
                        <button className="btn btn-sm" onClick={() => act(u, 'reactivate')}>
                          <RotateCcw size={13} /> Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !audit ? (
        <Spinner />
      ) : (
        <div className="glass" style={{ padding: 6, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>By</th>
                <th className="hide-mobile">Details</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.id}>
                  <td className="faint" title={formatDateTime(e.createdAt)}>{relativeTime(e.createdAt)}</td>
                  <td><code>{e.action}</code></td>
                  <td>{e.actor ?? <span className="faint">system / anonymous</span>}</td>
                  <td className="hide-mobile small faint truncate" style={{ maxWidth: 360 }}>{JSON.stringify(e.data)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <Modal
          title={confirm.action === 'reject' ? `Reject ${confirm.user.displayName}?` : `Deactivate ${confirm.user.displayName}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Back</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  await act(confirm.user, confirm.action, { reason: reason || undefined });
                  setConfirm(null);
                  setReason('');
                }}
              >
                {confirm.action === 'reject' ? 'Reject access' : 'Deactivate now'}
              </button>
            </>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>
            {confirm.action === 'deactivate'
              ? 'Their sessions are disconnected immediately and they cannot sign in to TaskSync. Their tasks and history are kept.'
              : 'They will see that their request was not approved. You can approve them later.'}
          </p>
          <label className="label" htmlFor="adm-reason">Reason (kept in the audit log)</label>
          <input id="adm-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Modal>
      )}
    </div>
  );
}
