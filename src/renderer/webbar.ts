// Browser column: web links open here instead of the system browser (Settings → General → Links).
// The page runs in a <webview> the main process hardens (no Node, sandbox, own session).

let webView: Electron.WebviewTag | null = null;

function paintWebNav(): void {
  el<HTMLButtonElement>('#web-back').disabled = !webView?.canGoBack();
  el<HTMLButtonElement>('#web-fwd').disabled = !webView?.canGoForward();
  const url = webView?.getURL() ?? '';
  el('#web-url').textContent = url.replace(/^https?:\/\//, '');
  el('#web-title').textContent = webView?.getTitle() || url.replace(/^https?:\/\//, '').split('/')[0];
}

function openWeb(url: string): void {
  document.body.classList.add('web-on');
  if (!webView) {
    webView = document.createElement('webview');
    webView.setAttribute('partition', 'agenoras-web');
    webView.setAttribute('src', url);
    const loading = (on: boolean) => el('#webbar').classList.toggle('loading', on);
    webView.addEventListener('did-start-loading', () => loading(true));
    webView.addEventListener('did-stop-loading', () => {
      loading(false);
      paintWebNav();
    });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated']) webView.addEventListener(ev, paintWebNav);
    el('#web-host').appendChild(webView);
  } else void webView.loadURL(url).catch(() => {});
  el('#web-url').textContent = url.replace(/^https?:\/\//, '');
}

function closeWeb(): void {
  document.body.classList.remove('web-on');
  // gone completely: no page keeps running (sound, video) in the background
  webView?.remove();
  webView = null;
}

el('#web-back').addEventListener('click', () => webView?.goBack());
el('#web-fwd').addEventListener('click', () => webView?.goForward());
el('#web-reload').addEventListener('click', () => webView?.reload());
el('#web-ext').addEventListener('click', () => {
  const url = webView?.getURL();
  if (url) void window.api.web.external(url);
});
el('#web-close').addEventListener('click', closeWeb);
window.api.web.onOpen(openWeb);

// Offline sign in the title bar
const paintOnline = () => (el('#tb-offline').hidden = navigator.onLine);
window.addEventListener('online', paintOnline);
window.addEventListener('offline', paintOnline);
paintOnline();
