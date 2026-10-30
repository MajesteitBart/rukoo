'use strict';

// Jitsi Meet: no account and no API. A room exists as soon as someone opens its address, so each booking gets a room
// name nobody can guess, on meet.jit.si or the host's own Jitsi server. Moving a booking keeps the room; there is
// nothing to delete when it is cancelled.
const crypto = require('crypto');
const { t } = require('../../i18n');
const { videoError } = require('./oauth');

const DEFAULT_SERVER = 'https://meet.jit.si';
const ROOM_CHARS = 'abcdefghijklmnopqrstuvwxyz';
const ROOM_LENGTH = 22;

// A room name of 22 random letters (about 103 bits) after a fixed prefix; nothing from the booking. Letters only,
// because Jitsi shows the room name as the meeting's title and splits it at every digit.
function roomName(random = crypto.randomBytes) {
  const bytes = random(48);
  let out = '';
  // 234 is the largest multiple of 26 up to 256: bytes from it up are skipped, so every letter is equally likely.
  for (const b of bytes) {
    if (b >= 234) continue;
    out += ROOM_CHARS[b % 26];
    if (out.length === ROOM_LENGTH) break;
  }
  if (out.length < ROOM_LENGTH) return roomName(random);
  return `rukoo-${out}`;
}

// A Jitsi server address as https://host[/path], or '' for the default; throws for anything else.
function serverAddress(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch (_) {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || text.length > 300) {
    throw videoError('invalid', t('errors.video.jitsiServer'));
  }
  const out = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return out === DEFAULT_SERVER ? '' : out;
}

function jitsi() {
  return {
    id: 'jitsi',
    name: 'Jitsi Meet',
    kind: 'room',
    create({ server }) {
      const room = roomName();
      return { id: room, url: `${server || DEFAULT_SERVER}/${room}` };
    }
  };
}

module.exports = { jitsi, roomName, serverAddress, DEFAULT_SERVER };
