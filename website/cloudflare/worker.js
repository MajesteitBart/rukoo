// rukoo.io. www.rukoo.io redirects to the apex. A GET or HEAD for one of the site's files (site/, with the rules in
// site/_redirects and site/_headers) is answered from there; every other request goes to the Rukoo account server
// (server/ in this repository), which answers the account API (/v1), booking pages (/<handle>), the MCP
// endpoint for assistants (/mcp), llms.txt and /privacy. The site's one form, early access, is answered here.
import { PATH as EARLY_ACCESS, earlyAccess } from './early-access.js';

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
    if (request.method === 'GET' || request.method === 'HEAD') {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    return env.ACCOUNT.fetch(request);
  }
};
