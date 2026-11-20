// rukoo.io. www.rukoo.io redirects to the apex. A GET or HEAD for one of the site's files (site/, with the rules in
// site/_redirects and site/_headers) is answered from there; every other request goes to the Rukoo account server
// (server/ in this repository), which answers the account API (/v1), booking pages (/<handle>), the MCP
// endpoint for assistants (/mcp), llms.txt and /privacy. The site's one form, early access, is answered here.
// The account API under /v1 has no site file, so it goes to the account server without looking for one: a sync or
// chat request then costs one hop less, and a WebSocket upgrade reaches the server that answers it.
// Rukoo in the browser lives under /app, and a workspace invitation link at /join leads there (web-app.js).
import { PATH as EARLY_ACCESS, earlyAccess } from './early-access.js';
import { appResponse, isAppPath, joinResponse } from './web-app.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.rukoo.io') {
      url.hostname = 'rukoo.io';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === EARLY_ACCESS) {
      if (request.method === 'POST') return earlyAccess(request, env);
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return env.ACCOUNT.fetch(request);
    if (isAppPath(url.pathname)) return appResponse(request, env, url);
    const reading = request.method === 'GET' || request.method === 'HEAD';
    if (url.pathname === '/join' && reading) return joinResponse(request, env);
    if (reading) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    return env.ACCOUNT.fetch(request);
  }
};
