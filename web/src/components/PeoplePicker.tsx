import { useMemo, useState } from 'react';
import type { UserSummary } from '@tasksync/shared';
import { Check, Search } from 'lucide-react';
import { matchPeople } from './MentionInput';
import { Avatar } from './ui';

export function PeoplePicker({
  people,
  selected,
  onChange,
  exclude = [],
  single,
}: {
  people: UserSummary[];
  selected: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
  single?: boolean;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(
    () => matchPeople(people.filter((p) => !exclude.includes(p.id)), q, 50),
    [people, exclude, q],
  );
  const toggle = (id: string) =>
    onChange(single ? [id] : selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ position: 'relative' }}>
        <Search size={15} className="faint" style={{ position: 'absolute', left: 12 }} />
        <input className="input" style={{ paddingLeft: 34 }} placeholder="Search colleagues" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="col" style={{ gap: 2, maxHeight: 280, overflow: 'auto' }} role="listbox" aria-multiselectable={!single}>
        {list.length === 0 && <div className="faint small" style={{ padding: 8 }}>No matching approved colleagues.</div>}
        {list.map((u) => {
          const on = selected.includes(u.id);
          return (
            <button key={u.id} type="button" role="option" aria-selected={on} className={`menu-item ${on ? 'active' : ''}`} onClick={() => toggle(u.id)}>
              <Avatar id={u.id} name={u.displayName} />
              <span className="col" style={{ gap: 0, minWidth: 0, flex: 1 }}>
                <span className="truncate">{u.displayName}</span>
                <span className="sub truncate">{[u.jobTitle, u.department].filter(Boolean).join(' · ') || u.email}</span>
              </span>
              {on && <Check size={16} color="#a5b4fc" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
