'use strict';

// Zoom: a General app's OAuth client, signed in with PKCE to the user's own Zoom account, and the Zoom Meetings API.
// https://developers.zoom.us/docs/integrations/oauth/ and https://developers.zoom.us/docs/api/meetings/
// The app's scopes are chosen in the Zoom App Marketplace, not asked for here: meeting:write:meeting,
// meeting:update:meeting, meeting:delete:meeting and user:read:user (docs/booking.md).

const ENDPOINTS = {
  auth: 'https://zoom.us/oauth/authorize',
  token: 'https://zoom.us/oauth/token',
  api: 'https://api.zoom.us/v2'
};

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const minutes = (m) => Math.max(1, Math.round((m.end - m.start) / 60000));

function zoom({ endpoints = ENDPOINTS } = {}) {
  const e = { ...ENDPOINTS, ...endpoints };
  return {
    id: 'zoom',
    name: 'Zoom',
    kind: 'oauth',
    env: { id: 'SEM_ZOOM_CLIENT_ID', secret: 'SEM_ZOOM_CLIENT_SECRET' },
    file: 'zoom-oauth.json',
    api: e.api,
    // Zoom matches a loopback redirect on 127.0.0.1 and its path, ignoring the port: register http://127.0.0.1/callback.
    oauth: () => ({ name: 'Zoom', auth: e.auth, token: e.token, scopes: [], host: '127.0.0.1', path: '/callback', basicAuth: true }),
    errorText: (body) => (body && typeof body.message === 'string' ? body.message : ''),
    async profile(call) {
      const me = (await call('GET', '/users/me')) || {};
      const name = me.display_name || [me.first_name, me.last_name].filter(Boolean).join(' ');
      return { email: String(me.email || '').toLowerCase(), name: String(name || '') };
    },
    // A scheduled meeting (type 2) in the host's Zoom account, with the account's own meeting settings.
    async create(call, m) {
      const res = await call('POST', '/users/me/meetings', { topic: m.title.slice(0, 200), type: 2, start_time: iso(m.start), duration: minutes(m), timezone: m.timeZone });
      if (!res || (typeof res.id !== 'number' && typeof res.id !== 'string') || typeof res.join_url !== 'string' || !/^https:\/\//.test(res.join_url)) return null;
      return { id: String(res.id), url: res.join_url };
    },
    async update(call, ref, m) {
      await call('PATCH', `/meetings/${encodeURIComponent(ref.id)}`, { start_time: iso(m.start), duration: minutes(m), timezone: m.timeZone });
    },
    async remove(call, ref) {
      await call('DELETE', `/meetings/${encodeURIComponent(ref.id)}`);
    }
  };
}

module.exports = { zoom, ENDPOINTS };
