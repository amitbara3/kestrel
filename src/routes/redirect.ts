/**
 * GET /:code — the hot path.
 *
 * Everything here is arranged around not doing work: a shape check before any
 * I/O, a cache-tier header so the hit ratio is observable, an asynchronous
 * click record, and HTML error pages only for the browser cases where a JSON
 * body would be shown as raw text.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { isPlausibleCode } from '../core/alias.js';
import { AppError, isAppError } from '../core/errors.js';
import type { ClickTracker } from '../services/analytics.js';
import type { LinkService } from '../services/link-service.js';
import type { Metrics } from '../middleware/metrics.js';

export interface RedirectRouteOptions {
  service: LinkService;
  clicks: ClickTracker;
  metrics: Metrics;
}

export function registerRedirectRoute(app: FastifyInstance, options: RedirectRouteOptions): void {
  const { service, clicks, metrics } = options;

  app.get<{ Params: { code: string } }>(
    '/:code',
    { config: { rateLimitTier: 'redirect' } },
    async (request, reply) => {
      const { code } = request.params;

      // Reject implausible codes before touching any tier — an enumeration
      // attempt with junk input should cost nothing but a regex.
      if (!isPlausibleCode(code)) {
        metrics.redirects.inc(metrics.withInstance({ outcome: 'invalid' }));
        return sendError(reply, 404, 'Not found', 'That short link does not exist.');
      }

      try {
        const { link, tier } = await service.resolve(code);

        // Fire-and-forget by design: a click write must never delay a redirect.
        clicks.record(code);

        metrics.redirects.inc(metrics.withInstance({ outcome: 'ok' }));

        return reply
          .header('X-Cache', tier.toUpperCase())
          // An intermediary must not cache a link that can be deleted or expire.
          .header('Cache-Control', 'private, max-age=0, no-store')
          .header('Referrer-Policy', 'no-referrer')
          .redirect(link.url, 302);
      } catch (err) {
        if (isAppError(err) && err.code === 'NOT_FOUND') {
          metrics.redirects.inc(metrics.withInstance({ outcome: 'not_found' }));
          return sendError(reply, 404, 'Not found', 'That short link does not exist.');
        }
        if (isAppError(err) && err.code === 'GONE') {
          metrics.redirects.inc(metrics.withInstance({ outcome: 'expired' }));
          return sendError(reply, 410, 'Expired', 'That short link has expired.');
        }
        throw err;
      }
    },
  );
}

/**
 * Content-negotiated error. A browser following a dead link gets a readable
 * page; an API client gets the same envelope every other endpoint uses.
 */
function sendError(reply: FastifyReply, status: number, title: string, message: string) {
  const accept = reply.request.headers.accept ?? '';
  if (!accept.includes('text/html')) {
    return reply.status(status).send({
      error: {
        code: status === 410 ? 'GONE' : 'NOT_FOUND',
        message,
        requestId: reply.request.requestId,
      },
    });
  }

  return reply
    .status(status)
    .type('text/html; charset=utf-8')
    .send(errorPage(status, title, message, reply.request.requestId));
}

/**
 * Inline, self-contained page. Tokens mirror Design.md so a dead link still
 * looks like part of the product, and the palette is defined on bare :root with
 * dark redefined under both the media query and the explicit attribute.
 */
function errorPage(status: number, title: string, message: string, requestId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} ${escapeHtml(title)} — Kestrel</title>
<style>
  :root {
    --bg: #FAFAF9; --surface: #FFFFFF; --border: #E4E4E1;
    --text: #16181D; --text-dim: #5A6069; --text-faint: #8B929C; --accent: #B87400;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0B0D10; --surface: #12151A; --border: #242A33;
      --text: #E6EAF0; --text-dim: #9AA4B2; --text-faint: #5D6673; --accent: #F5A524;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0B0D10; --surface: #12151A; --border: #242A33;
    --text: #E6EAF0; --text-dim: #9AA4B2; --text-faint: #5D6673; --accent: #F5A524;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--text);
    font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 40px; max-width: 480px; width: 100%; text-align: center;
  }
  .status { font-size: 39px; font-weight: 700; letter-spacing: -0.02em; color: var(--accent); margin: 0; }
  h1 { font-size: 20px; font-weight: 600; margin: 12px 0 8px; }
  p { font-size: 14px; color: var(--text-dim); line-height: 1.6; margin: 0 0 24px; }
  a { color: var(--accent); text-decoration: none; font-size: 12.5px;
      text-transform: uppercase; letter-spacing: 0.08em; }
  a:hover { text-decoration: underline; }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  code { font-size: 12px; color: var(--text-faint); display: block; margin-top: 24px; }
</style>
</head>
<body>
  <main class="card">
    <p class="status">${status}</p>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/">Create a short link</a>
    <code>${escapeHtml(requestId)}</code>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { AppError };
