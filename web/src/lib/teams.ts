import { buildTeamsChatLink, isActiveStatus, type Task, type UserSummary } from '@tasksync/shared';
import { desktop, isDesktop } from './desktop';
import { firstName, formatDue } from './format';
import { blobToBase64, renderTaskCard, renderTaskSummary } from './taskImage';

export interface TeamsShareResult {
  copied: boolean;
  opened: boolean;
  /** Fallback when the clipboard is unavailable: the user can download the image instead. */
  imageUrl?: string;
}

export function teamsMessageFor(colleague: UserSummary, task?: Task): string {
  return task
    ? `Hi ${firstName(colleague.displayName)}, about "${task.title}"${task.dueAt ? ` (due ${formatDue(task.dueAt)})` : ''}: `
    : `Hi ${firstName(colleague.displayName)}, a quick update on our open tasks: `;
}

/**
 * "Message in Teams" workflow:
 *  1. render a PNG summary of the task (or of open tasks shared with the colleague),
 *  2. copy it to the Windows clipboard,
 *  3. open the one-to-one Teams chat with a prefilled message,
 *  4. the user pastes (Ctrl+V) and presses Send.
 * Teams deep links cannot attach images or send messages automatically; doing that would
 * need Microsoft Graph Chat.ReadWrite permissions, which are outside the free MVP.
 * Must be called directly from a click handler (clipboard and pop-ups need user activation).
 */
export async function messageInTeams(colleague: UserSummary, context: { task?: Task; shared?: Task[] }): Promise<TeamsShareResult> {
  const blobPromise = context.task
    ? renderTaskCard(context.task)
    : renderTaskSummary(colleague, (context.shared ?? []).filter((t) => isActiveStatus(t.status)));
  const message = teamsMessageFor(colleague, context.task);

  if (isDesktop) {
    // The Windows host owns the clipboard and launches the Teams app directly.
    desktop.copyImage(await blobToBase64(await blobPromise));
    desktop.openExternal(buildTeamsChatLink({ email: colleague.email, message, protocol: 'msteams' }));
    return { copied: true, opened: true };
  }

  let copied = false;
  if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    try {
      // Passing the promise keeps the click's user activation while the PNG renders.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      copied = true;
    } catch {
      copied = false;
    }
  }
  const win = window.open(buildTeamsChatLink({ email: colleague.email, message }), '_blank');
  if (win) win.opener = null;
  return { copied, opened: Boolean(win), imageUrl: copied ? undefined : URL.createObjectURL(await blobPromise) };
}
