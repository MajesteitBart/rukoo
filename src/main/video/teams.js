'use strict';

// Microsoft Teams: a public client on the Microsoft identity platform, signed in with PKCE, and Microsoft Graph's
// onlineMeetings. That endpoint makes a Teams meeting on its own, without an Outlook event that would send a second
// invitation; it needs a work or school account with Teams and the delegated scope OnlineMeetings.ReadWrite. Graph
// has no way to make a Teams meeting for a personal Microsoft account, so the default tenant is 'organizations'.
// https://learn.microsoft.com/graph/api/application-post-onlinemeetings

const LOGIN = 'https://login.microsoftonline.com';
const API = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['offline_access', 'User.Read', 'OnlineMeetings.ReadWrite'];
const TENANT = /^[A-Za-z0-9.-]{1,100}$/;

const iso = (ms) => new Date(ms).toISOString();

function teams({ endpoints = {} } = {}) {
  const login = endpoints.login || LOGIN;
  const api = endpoints.api || API;
  return {
    id: 'teams',
    name: 'Microsoft Teams',
    kind: 'oauth',
    env: { id: 'SEM_TEAMS_CLIENT_ID', tenant: 'SEM_TEAMS_TENANT' },
    file: 'teams-oauth.json',
    api,
    // Microsoft ignores the port of a localhost redirect: register http://localhost under Mobile and desktop
    // applications.
    oauth: (client) => {
      const tenant = client.tenant && TENANT.test(client.tenant) ? client.tenant : 'organizations';
      return {
        name: 'Microsoft Teams',
        auth: `${login}/${tenant}/oauth2/v2.0/authorize`,
        token: `${login}/${tenant}/oauth2/v2.0/token`,
        scopes: SCOPES,
        refreshScopes: true,
        host: 'localhost',
        path: '',
        basicAuth: false,
        params: { prompt: 'select_account' }
      };
    },
    errorText: (body) => (body && body.error && typeof body.error.message === 'string' ? body.error.message : ''),
    async profile(call) {
      const me = (await call('GET', '/me?$select=displayName,mail,userPrincipalName')) || {};
      return { email: String(me.mail || me.userPrincipalName || '').toLowerCase(), name: String(me.displayName || '') };
    },
    async create(call, m) {
      const res = await call('POST', '/me/onlineMeetings', { subject: m.title.slice(0, 255), startDateTime: iso(m.start), endDateTime: iso(m.end) });
      const url = res && (res.joinWebUrl || res.joinUrl);
      if (!res || typeof res.id !== 'string' || typeof url !== 'string' || !/^https:\/\//.test(url)) return null;
      return { id: res.id, url };
    },
    async update(call, ref, m) {
      await call('PATCH', `/me/onlineMeetings/${encodeURIComponent(ref.id)}`, { startDateTime: iso(m.start), endDateTime: iso(m.end) });
    },
    async remove(call, ref) {
      await call('DELETE', `/me/onlineMeetings/${encodeURIComponent(ref.id)}`);
    }
  };
}

module.exports = { teams, SCOPES };
