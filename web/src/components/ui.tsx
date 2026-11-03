import { useEffect, useRef, type ReactNode } from 'react';
import { PRIORITY_LABELS, STATUS_DESCRIPTIONS, STATUS_LABELS, type Priority, type TaskStatus } from '@tasksync/shared';
import { X } from 'lucide-react';
import { hueFor, initials } from '../lib/format';
import type { ConnectionStatus } from '../lib/realtime';

export function Avatar({ id, name, size = '' }: { id: string; name: string; size?: '' | 'sm' | 'lg' | 'xl' }) {
  return (
    <span className={`avatar ${size}`} style={{ ['--h' as string]: hueFor(id) }} title={name} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`badge s-${status}`} title={STATUS_DESCRIPTIONS[status]}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge plain p-${priority}`}>{PRIORITY_LABELS[priority]}</span>;
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty glass">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      {children && <div className="muted" style={{ maxWidth: 420 }}>{children}</div>}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim over-drawer" onClick={onClose} />
      <div className="modal glass glass-strong" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="row" style={{ marginBottom: 14 }}>
          <h3>{title}</h3>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
        {footer && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>{footer}</div>}
      </div>
    </>
  );
}

const CONN_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  live: 'Live',
  polling: 'Live (HTTP fallback)',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  denied: 'Access revoked',
};

export function ConnectionPill({ status, queued, onRetry }: { status: ConnectionStatus; queued: number; onRetry?: () => void }) {
  return (
    <button
      type="button"
      className={`conn ${status}`}
      onClick={status === 'live' ? undefined : onRetry}
      title={
        status === 'live'
          ? 'Changes sync instantly across your devices'
          : status === 'polling'
            ? 'Your network blocks live connections, so TaskSync checks for changes every 15 seconds'
            : 'Click to reconnect now'
      }
      style={{ cursor: status === 'live' ? 'default' : 'pointer' }}
    >
      <i />
      {CONN_LABEL[status]}
      {queued > 0 && <span className="faint">· {queued} to sync</span>}
    </button>
  );
}
