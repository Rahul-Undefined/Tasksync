import { mentionsToPlainText, PRIORITY_LABELS, STATUS_LABELS, type Task, type UserSummary } from '@tasksync/shared';
import { formatDue } from './format';

// Renders a TaskSync "summary card" as a PNG with the Canvas 2D API (no external
// libraries, no network). The image is what employees paste into a Teams chat.

const W = 1200;
const SCALE = 2;
const STATUS_COLOR: Record<string, string> = {
  pending: '#93a4c8',
  in_progress: '#60a5fa',
  completed: '#34d399',
  cancelled: '#f87171',
  declined: '#fbbf24',
  reassigned: '#c084fc',
};
const PRIORITY_COLOR: Record<string, string> = { low: '#94a3b8', medium: '#60a5fa', high: '#fbbf24', urgent: '#f87171' };
const FONT = '"Segoe UI Variable Text", "Segoe UI", "Inter Variable", Inter, system-ui, sans-serif';

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = test;
      if (lines.length >= maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length >= maxLines) break;
  }
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1]!;
    while (ctx.measureText(`${last}…`).width > maxWidth && last.length > 1) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, color: string): number {
  ctx.font = `600 22px ${FONT}`;
  const w = ctx.measureText(label).width + 44;
  ctx.fillStyle = `${color}22`;
  ctx.strokeStyle = `${color}88`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 40, 20);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x + 20, y + 20, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#eef1ff';
  ctx.fillText(label, x + 32, y + 28);
  return w;
}

function background(ctx: CanvasRenderingContext2D, h: number) {
  const bg = ctx.createLinearGradient(0, 0, W, h);
  bg.addColorStop(0, '#0a0f24');
  bg.addColorStop(1, '#120a26');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, h);
  for (const [x, y, r, c] of [
    [180, 80, 420, 'rgba(91,140,255,0.35)'],
    [W - 120, h - 40, 460, 'rgba(168,85,247,0.32)'],
  ] as const) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, h);
  }
  // glass panel
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(40, 40, W - 80, h - 80, 32);
  ctx.fill();
  ctx.stroke();
}

function footer(ctx: CanvasRenderingContext2D, h: number) {
  const grad = ctx.createLinearGradient(80, 0, 140, 0);
  grad.addColorStop(0, '#5b8cff');
  grad.addColorStop(1, '#c084fc');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(80, h - 112, 36, 36, 10);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(89, h - 94);
  ctx.lineTo(96, h - 87);
  ctx.lineTo(107, h - 101);
  ctx.stroke();
  ctx.fillStyle = 'rgba(226,232,255,0.75)';
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText('TaskSync', 128, h - 86);
  ctx.font = `400 20px ${FONT}`;
  ctx.fillStyle = 'rgba(226,232,255,0.45)';
  const stamp = `Shared ${new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`;
  ctx.fillText(stamp, W - 80 - ctx.measureText(stamp).width, h - 86);
}

function makeCanvas(h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = h * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.scale(SCALE, SCALE);
  return { canvas, ctx };
}

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));

export async function renderTaskCard(task: Task): Promise<Blob> {
  const H = 640;
  const { canvas, ctx } = makeCanvas(H);
  background(ctx, H);
  let x = 80;
  x += pill(ctx, x, 84, STATUS_LABELS[task.status], STATUS_COLOR[task.status] ?? '#93a4c8') + 12;
  x += pill(ctx, x, 84, `${PRIORITY_LABELS[task.priority]} priority`, PRIORITY_COLOR[task.priority] ?? '#60a5fa') + 12;
  if (task.dueAt) pill(ctx, x, 84, `Due ${formatDue(task.dueAt)}`, Date.parse(task.dueAt) < Date.now() ? '#f87171' : '#93a4c8');

  ctx.fillStyle = '#ffffff';
  ctx.font = `650 50px ${FONT}`;
  const titleLines = wrap(ctx, task.title, W - 160, 2);
  titleLines.forEach((l, i) => ctx.fillText(l, 80, 190 + i * 60));
  let y = 190 + titleLines.length * 60;

  const desc = mentionsToPlainText(task.description).trim();
  if (desc) {
    ctx.font = `400 26px ${FONT}`;
    ctx.fillStyle = 'rgba(226,232,255,0.72)';
    const lines = wrap(ctx, desc, W - 160, 3);
    lines.forEach((l, i) => ctx.fillText(l, 80, y + 10 + i * 38));
    y += 10 + lines.length * 38;
  }

  const active = task.assignees.filter((a) => a.status === 'active').map((a) => a.user.displayName);
  ctx.font = `500 24px ${FONT}`;
  ctx.fillStyle = 'rgba(226,232,255,0.55)';
  ctx.fillText('Assigned to', 80, H - 200);
  ctx.fillText('Created by', 640, H - 200);
  ctx.font = `600 28px ${FONT}`;
  ctx.fillStyle = '#eef1ff';
  ctx.fillText(wrap(ctx, active.join(', ') || '—', 520, 1)[0] ?? '—', 80, H - 160);
  ctx.fillText(wrap(ctx, task.createdBy.displayName, 480, 1)[0] ?? '', 640, H - 160);
  void y;
  footer(ctx, H);
  return toBlob(canvas);
}

/** A summary of several tasks shared between the viewer and a colleague. */
export async function renderTaskSummary(colleague: UserSummary, tasks: Task[]): Promise<Blob> {
  const shown = tasks.slice(0, 6);
  const H = 300 + Math.max(1, shown.length) * 78 + 60;
  const { canvas, ctx } = makeCanvas(H);
  background(ctx, H);
  ctx.fillStyle = '#ffffff';
  ctx.font = `650 44px ${FONT}`;
  ctx.fillText(`Open tasks with ${colleague.displayName}`, 80, 140);
  ctx.font = `400 24px ${FONT}`;
  ctx.fillStyle = 'rgba(226,232,255,0.6)';
  ctx.fillText(`${tasks.length} open task${tasks.length === 1 ? '' : 's'}`, 80, 182);
  let y = 230;
  if (shown.length === 0) {
    ctx.fillText('No open tasks right now.', 80, y + 40);
  }
  for (const t of shown) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.roundRect(70, y, W - 140, 64, 16);
    ctx.fill();
    ctx.fillStyle = STATUS_COLOR[t.status] ?? '#93a4c8';
    ctx.beginPath();
    ctx.arc(100, y + 32, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 26px ${FONT}`;
    ctx.fillStyle = '#eef1ff';
    ctx.fillText(wrap(ctx, t.title, 680, 1)[0] ?? '', 124, y + 41);
    ctx.font = `400 22px ${FONT}`;
    ctx.fillStyle = 'rgba(226,232,255,0.6)';
    const meta = `${STATUS_LABELS[t.status]} · ${t.dueAt ? formatDue(t.dueAt) : 'No due date'}`;
    ctx.fillText(meta, W - 100 - ctx.measureText(meta).width, y + 40);
    y += 78;
  }
  footer(ctx, H);
  return toBlob(canvas);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
