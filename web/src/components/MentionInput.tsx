import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { UserSummary } from '@tasksync/shared';
import { Avatar } from './ui';

export interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  candidates: UserSummary[];
  /** "consume" removes the typed @query (used to turn mentions into assignee chips); "insert" leaves "@Name". */
  onPick: (user: UserSummary) => 'consume' | 'insert';
  onSubmit?: () => void;
  placeholder?: string;
  multiline?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  /** Extra keyboard handling when the suggestion list is closed. */
  onKeyDownExtra?: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  /** Called (debounced) with the @query when nothing matches locally, e.g. to search the server. */
  onQuery?: (query: string) => void;
}

/** Finds an "@query" that ends at the caret (query may contain spaces for full names). */
export function findMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && /[\w.]/.test(before[at - 1]!)) return null; // part of an email address
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query) || /\s{2,}/.test(query)) return null;
  return { start: at, query };
}

export function matchPeople(candidates: UserSummary[], query: string, limit = 8): UserSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, limit);
  const scored = candidates
    .map((u) => {
      const name = u.displayName.toLowerCase();
      const score = name.startsWith(q) ? 0 : name.split(/\s+/).some((p) => p.startsWith(q)) ? 1 : name.includes(q) || u.email.includes(q) ? 2 : 9;
      return { u, score };
    })
    .filter((x) => x.score < 9)
    .sort((a, b) => a.score - b.score || a.u.displayName.localeCompare(b.u.displayName));
  return scored.slice(0, limit).map((x) => x.u);
}

export function MentionInput(props: MentionInputProps) {
  const { value, onChange, candidates, onPick, onSubmit, placeholder, multiline, autoFocus, ariaLabel, onKeyDownExtra, onQuery } = props;
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => (mention ? matchPeople(candidates, mention.query) : []), [mention, candidates]);
  const open = Boolean(mention) && matches.length > 0;

  useEffect(() => {
    if (!onQuery || !mention || matches.length > 0 || mention.query.trim().length < 2) return;
    const t = setTimeout(() => onQuery(mention.query.trim()), 250);
    return () => clearTimeout(t);
  }, [mention, matches.length, onQuery]);

  const update = (text: string, caret: number) => {
    onChange(text);
    setMention(findMentionQuery(text, caret));
    setActive(0);
  };

  const pick = (user: UserSummary) => {
    if (!mention) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const mode = onPick(user);
    const insert = mode === 'consume' ? '' : `@${user.displayName} `;
    const next = (value.slice(0, mention.start) + insert + value.slice(caret)).replace(/\s{2,}/g, ' ');
    onChange(mode === 'consume' ? next.trimStart() : next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = Math.min(mention.start + insert.length, next.length);
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && onSubmit && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
      return;
    }
    onKeyDownExtra?.(e);
  };

  const common = {
    ref,
    value,
    placeholder,
    autoFocus,
    'aria-label': ariaLabel ?? placeholder,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': open,
    onKeyDown,
    onChange: (e: { target: HTMLInputElement | HTMLTextAreaElement }) => update(e.target.value, e.target.selectionStart ?? e.target.value.length),
    onBlur: () => setTimeout(() => setMention(null), 150),
  };

  return (
    <div className="mention-wrap">
      {multiline ? <textarea className="textarea" {...common} /> : <input className="input" {...common} />}
      {open && (
        <div className="popover glass glass-strong" role="listbox" style={{ top: 'calc(100% + 6px)', left: 0 }}>
          {matches.map((u, i) => (
            <button
              key={u.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`menu-item ${i === active ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <Avatar id={u.id} name={u.displayName} />
              <span className="col" style={{ gap: 0, minWidth: 0 }}>
                <span className="truncate">{u.displayName}</span>
                <span className="sub truncate">{[u.jobTitle, u.department].filter(Boolean).join(' · ') || u.email}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
