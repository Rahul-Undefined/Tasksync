import { createRoot } from 'react-dom/client';
import { WidgetPage } from '../pages/Widget';
import { toast } from './store';
import { SurfaceContext } from './surface';

// Floating, always-on-top widget without installing anything, using Edge/Chrome's
// Document Picture-in-Picture API. The widget runs in the same JavaScript context as the
// dashboard, so it shares the same live data, sign-in and realtime connection.

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

const api = (): DocumentPictureInPicture | undefined =>
  (globalThis as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;

export const floatingWidgetSupported = () => typeof window !== 'undefined' && Boolean(api());

/** Must be called from a click (the browser requires a user gesture). */
export async function openFloatingWidget(): Promise<void> {
  const pip = api();
  if (!pip) {
    toast({ kind: 'error', title: 'Not supported here', body: 'Open TaskSync in Microsoft Edge (version 116 or newer) to pop out the widget.' });
    return;
  }
  if (pip.window) {
    pip.window.focus();
    return;
  }
  const win = await pip.requestWindow({ width: 380, height: 580 });
  win.document.title = 'TaskSync';
  win.document.documentElement.style.colorScheme = 'dark';

  // Bring the app's styles (absolute URLs, so they resolve inside the new document).
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    if (node instanceof HTMLLinkElement) {
      const link = win.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = node.href;
      win.document.head.appendChild(link);
    } else {
      win.document.head.appendChild(node.cloneNode(true));
    }
  }

  const backdrop = win.document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = '<div class="blob b1"></div><div class="blob b2"></div><div class="grain"></div>';
  const container = win.document.createElement('div');
  container.id = 'root';
  container.style.height = '100%';
  win.document.body.append(backdrop, container);

  const root = createRoot(container);
  root.render(
    <SurfaceContext.Provider value="pip">
      <WidgetPage variant="pip" onClose={() => win.close()} />
    </SurfaceContext.Provider>,
  );
  win.addEventListener('pagehide', () => root.unmount(), { once: true });
}
