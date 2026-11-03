import { describe, expect, it } from 'vitest';
import {
  buildTeamsChatLink,
  extractMentionIds,
  formatMention,
  mentionsToPlainText,
  type Task,
  type TaskAssignee,
  type UserSummary,
} from '@tasksync/shared';
import { findMentionQuery, matchPeople } from '../components/MentionInput';
import { dueBucket, newer, selectAssigned, selectCompleted, selectMy } from './views';
import { teamsMessageFor } from './teams';

const user = (id: string, name: string): UserSummary => ({ id, displayName: name, email: `${name.split(' ')[0]!.toLowerCase()}@example.com`, jobTitle: null, department: null });
const RAHUL = user('11111111-1111-4111-8111-111111111111', 'Rahul Tester');
const STELLA = user('22222222-2222-4222-8222-222222222222', 'Stella Tester');
const MIKE = user('33333333-3333-4333-8333-333333333333', 'Mike Tester');

function task(p: Omit<Partial<Task>, 'assignees'> & { assignees?: [UserSummary, TaskAssignee['status']][] }): Task {
  const { assignees = [[STELLA, 'active']], ...rest } = p;
  return {
    id: Math.random().toString(36),
    title: 'Task',
    description: '',
    priority: 'medium',
    status: 'pending',
    dueAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    version: 1,
    createdBy: RAHUL,
    completedAt: null,
    completedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    commentCount: 0,
    assignees: assignees.map(([u, status], i) => ({ assignmentId: `a${i}`, user: u, status, assignedAt: '', assignedById: RAHUL.id, endedAt: null, note: null })),
    ...rest,
  };
}

describe('task views mirror the server rules', () => {
  it('[T9] Rahul → Stella: active for both; completion moves it to Completed for both', () => {
    const t = task({});
    expect(selectMy([t], STELLA.id)).toHaveLength(1);
    expect(selectAssigned([t], RAHUL.id)).toHaveLength(1);
    expect(selectMy([t], RAHUL.id)).toHaveLength(0);
    const done = { ...t, status: 'completed' as const, completedAt: '2026-11-02T10:00:00.000Z', completedBy: STELLA, version: 2 };
    expect(selectMy([done], STELLA.id)).toHaveLength(0);
    expect(selectAssigned([done], RAHUL.id)).toHaveLength(0);
    expect(selectCompleted([done], STELLA.id)).toHaveLength(1);
    expect(selectCompleted([done], RAHUL.id)).toHaveLength(1);
  });

  it('[T6] self-assigned tasks are in My Tasks but not Assigned by Me', () => {
    const t = task({ assignees: [[RAHUL, 'active']] });
    expect(selectMy([t], RAHUL.id)).toHaveLength(1);
    expect(selectAssigned([t], RAHUL.id)).toHaveLength(0);
  });

  it('[T12] declined tasks leave the assignee list and stay with the creator', () => {
    const t = task({ status: 'declined', assignees: [[STELLA, 'declined']] });
    expect(selectMy([t], STELLA.id)).toHaveLength(0);
    expect(selectAssigned([t], RAHUL.id)).toHaveLength(1);
    expect(selectCompleted([t], STELLA.id)).toHaveLength(0);
  });

  it('[T10] reassigned tasks move from the old to the new assignee', () => {
    const t = task({ status: 'reassigned', assignees: [[STELLA, 'reassigned'], [MIKE, 'active']] });
    expect(selectMy([t], STELLA.id)).toHaveLength(0);
    expect(selectMy([t], MIKE.id)).toHaveLength(1);
  });

  it('[T16] the newest version wins; equal versions fall back to updatedAt', () => {
    const v1 = task({ version: 1 });
    const v2 = { ...v1, version: 2, title: 'newer' };
    expect(newer(v2, v1).title).toBe('newer');
    expect(newer(v1, v2).title).toBe('newer');
    const later = { ...v1, updatedAt: '2026-11-03T00:00:00.000Z', commentCount: 3 };
    expect(newer(v1, later).commentCount).toBe(3);
    expect(newer(later, v1).commentCount).toBe(3);
  });

  it('groups by due date', () => {
    const now = new Date('2026-11-03T09:00:00');
    expect(dueBucket(task({ dueAt: '2026-11-02T09:00:00' }), now)).toBe('overdue');
    expect(dueBucket(task({ dueAt: new Date('2026-11-03T17:00:00').toISOString() }), now)).toBe('today');
    expect(dueBucket(task({ dueAt: new Date('2026-11-06T17:00:00').toISOString() }), now)).toBe('week');
    expect(dueBucket(task({ dueAt: null }), now)).toBe('none');
  });
});

describe('@mentions', () => {
  it('finds the @query being typed, but not inside email addresses', () => {
    expect(findMentionQuery('Review ledger @Ste', 18)).toEqual({ start: 14, query: 'Ste' });
    expect(findMentionQuery('Mail rahul@example.com', 22)).toBeNull();
    expect(findMentionQuery('@Stella Tester', 14)).toEqual({ start: 0, query: 'Stella Tester' });
    expect(findMentionQuery('no mention', 10)).toBeNull();
  });

  it('ranks people by name prefix, then word prefix, then substring', () => {
    const people = [MIKE, STELLA, RAHUL, user('44444444-4444-4444-8444-444444444444', 'Ste Fan')];
    // prefix matches first, then substring matches ("Te-ste-r")
    expect(matchPeople(people, 'ste').map((u) => u.displayName)).toEqual(['Ste Fan', 'Stella Tester', 'Mike Tester', 'Rahul Tester']);
    expect(matchPeople(people, 'tester').map((u) => u.displayName)).toEqual(['Mike Tester', 'Rahul Tester', 'Stella Tester']);
    expect(matchPeople(people, 'zzz')).toEqual([]);
  });

  it('round-trips mention tokens', () => {
    const body = `Please check ${formatMention(STELLA)} and ${formatMention({ id: MIKE.id, displayName: 'Mike [x] Tester' })}`;
    expect(extractMentionIds(body)).toEqual([STELLA.id, MIKE.id]);
    expect(mentionsToPlainText(body)).toBe('Please check @Stella Tester and @Mike x Tester');
  });
});

describe('[T20] Teams deep links', () => {
  it('builds the one-to-one chat link with an encoded prefilled message', () => {
    const t = task({ title: 'Q3 close & review', dueAt: null });
    const url = buildTeamsChatLink({ email: STELLA.email, message: teamsMessageFor(STELLA, t) });
    expect(url).toBe('https://teams.microsoft.com/l/chat/0/0?users=stella@example.com&message=Hi%20Stella%2C%20about%20%22Q3%20close%20%26%20review%22%3A%20');
    expect(buildTeamsChatLink({ email: 'A@Example.com', protocol: 'msteams' })).toBe('msteams:/l/chat/0/0?users=a@example.com');
  });

  it('refuses malformed or injected addresses', () => {
    expect(() => buildTeamsChatLink({ email: 'not-an-email' })).toThrow();
    expect(() => buildTeamsChatLink({ email: 'a@example.com&users=b@evil.com' })).toThrow();
    expect(() => buildTeamsChatLink({ email: 'a@example.com#x' })).toThrow();
  });
});
