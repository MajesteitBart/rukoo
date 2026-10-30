// Open times on a booking page (PROTOCOL.md, Slots). Pure functions over what the booking device published and the
// bookings the page holds; the Booking object calls them inside its synchronous stretches, so nothing here awaits.

import { DAY, addDays, offsetMs, zonedInstant, zonedParts } from './zone.js';

const MINUTE = 60000;
const pad = (n) => String(n).padStart(2, '0');
export const PENDING_HOLD = 48 * 60 * 60 * 1000;

// The lengths a guest can pick for a type, shortest first. A profile published before types had several lengths has
// only duration.
export function lengths(type) {
  return Array.isArray(type.durations) && type.durations.length ? type.durations : [type.duration];
}

// The type as booked at one of its lengths: duration is that length, and so is the step between start times when the
// host left it to follow the length (step()).
export function withLength(type, minutes) {
  if (minutes === type.duration) return type;
  return { ...type, duration: minutes };
}

// Minutes between start times. slotFollowsLength: they follow the length, the one picked on a type with several
// (input.js stores the default duration in slotInterval then, for Workers from before several lengths). A null
// slotInterval means the same.
export function step(type) {
  return type.slotFollowsLength || type.slotInterval === null || type.slotInterval === undefined ? type.duration : type.slotInterval;
}

// The meeting type a guest asked for: by slug (hidden types too), or the only visible one when none was named. With
// duration (minutes), the type at that length; without it, at its default length.
// Returns { type } or { error: 'unknown_type' | 'type_required', visible: [slugs] } or { error: 'unknown_duration',
// durations: [minutes] }.
export function resolveType(profile, slug, duration = null) {
  const visible = profile.types.filter((t) => !t.hidden).map((t) => t.slug);
  let type = null;
  if (slug) {
    type = profile.types.find((t) => t.slug === slug);
    if (!type) return { error: 'unknown_type', visible };
  } else if (visible.length === 1) {
    type = profile.types.find((t) => t.slug === visible[0]);
  } else {
    return { error: visible.length ? 'type_required' : 'unknown_type', visible };
  }
  if (duration === null || duration === undefined) return { type };
  const offered = lengths(type);
  return offered.includes(duration) ? { type: withLength(type, duration) } : { error: 'unknown_duration', durations: offered };
}

// Wall-clock candidates: every interval minutes from local midnight on each host-local day, as { start, date }, for
// starts in [from, to) whose meeting [start, start + duration] fits inside one window. A time the clock skips isn't
// a candidate; of a time it shows twice, the first instance is.
export function candidates({ windows, timeZone, interval, duration, from, to }) {
  const out = [];
  if (!windows.length || from >= to) return out;
  const length = duration * MINUTE;
  let date = zonedParts(from, timeZone).date;
  const last = zonedParts(to, timeZone).date;
  for (let guard = 0; guard < 400; guard++, date = addDays(date, 1)) {
    const dayStart = zonedInstant(date, '00:00', timeZone);
    const next = zonedInstant(addDays(date, 1), '00:00', timeZone);
    if (dayStart >= to) break;
    // Most days the offset holds from midnight to midnight, and the candidates are plain steps. A day with a clock
    // change, or one starting at a skipped midnight, goes minute by minute through the zone data.
    const off = offsetMs(dayStart, timeZone);
    const plain = offsetMs(dayStart - 1, timeZone) === off && offsetMs(next - 1, timeZone) === off;
    for (let m = 0; m < 24 * 60; m += interval) {
      let start;
      if (plain) {
        start = dayStart + m * MINUTE;
        if (start >= next) break;
      } else {
        const time = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
        start = zonedInstant(date, time, timeZone);
        const back = zonedParts(start, timeZone);
        if (back.date !== date || back.time !== time) continue;
      }
      if (start < from || start >= to) continue;
      if (inside(windows, start, start + length)) out.push({ start, date });
    }
    if (date === last) break;
  }
  return out;
}

// Whether [s, e] lies within one interval of a sorted, non-overlapping list.
function inside(list, s, e) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= s) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 && list[found][1] >= e;
}

// Whether [s, e) overlaps an interval of a sorted, merged list.
function overlaps(list, s, e) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = list[mid];
    if (b <= s) lo = mid + 1;
    else if (a >= e) hi = mid - 1;
    else return true;
  }
  return false;
}

export function merge(list) {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of sorted) {
    const tail = out[out.length - 1];
    if (tail && a <= tail[1]) tail[1] = Math.max(tail[1], b);
    else out.push([a, b]);
  }
  return out;
}

// A booking keeps its length when it moves: the length the guest picked, also after the host changed its type's
// lengths. Its new time is checked as its own type with the booking's length (end - start); buffers, notice and limits
// stay the type's, and so does the step between start times unless it follows the length. A booking of another type,
// or none, leaves the type as it is.
export function movingType(type, booking) {
  if (!booking || booking.type !== type.slug) return type;
  return withLength(type, (booking.end - booking.start) / MINUTE);
}

// When a pending request lapses: 48 hours after it was made, or its start minus the type's minimum notice.
export function expiresAt(createdAt, start, minNotice) {
  return Math.min(createdAt + PENDING_HOLD, start - minNotice * MINUTE);
}

// The open starts of one type in [from, to), as { start, date }.
//   profile, windows, busy: as published; bookings: the page's active bookings ({ id, type, start, end });
//   exclude: a booking id that doesn't count against itself (a reschedule; pass its type through movingType() so the
//   new time is checked at the booking's own length); dark: offer nothing.
export function openSlots({ profile, windows, busy, bookings, type, from, to, now, exclude = null, dark = false }) {
  if (dark) return [];
  const lo = Math.max(from, now + type.minNotice * MINUTE);
  const hi = Math.min(to, now + type.horizon * DAY);
  if (lo >= hi) return [];
  const list = candidates({
    windows: windows[type.schedule] ?? [],
    timeZone: profile.timeZone,
    interval: step(type),
    duration: type.duration,
    from: lo,
    to: hi
  });
  if (!list.length) return list;

  const types = new Map(profile.types.map((t) => [t.slug, t]));
  const others = bookings.filter((b) => b.id !== exclude);
  const blocked = merge([
    ...busy.map(([a, b]) => [a, b]),
    ...others.map((b) => {
      const t = types.get(b.type);
      return [b.start - (t ? t.bufferBefore : 0) * MINUTE, b.end + (t ? t.bufferAfter : 0) * MINUTE];
    })
  ]);
  // Bookings per host-local day, all types and this type, for the page's cap and the type's limit.
  const all = new Map();
  const same = new Map();
  for (const b of others) {
    const date = zonedParts(b.start, profile.timeZone).date;
    all.set(date, (all.get(date) ?? 0) + 1);
    if (b.type === type.slug) same.set(date, (same.get(date) ?? 0) + 1);
  }
  const before = type.bufferBefore * MINUTE;
  const after = type.bufferAfter * MINUTE;
  const length = type.duration * MINUTE;
  return list.filter(({ start, date }) => {
    if ((all.get(date) ?? 0) >= profile.dailyCap) return false;
    if (type.dailyLimit !== null && (same.get(date) ?? 0) >= type.dailyLimit) return false;
    return !overlaps(blocked, start - before, start + length + after);
  });
}

// Whether a start is open right now for a type.
export function isOpen(o, start) {
  return openSlots({ ...o, from: start, to: start + 1 }).some((s) => s.start === start);
}

// Up to n open starts nearest to a wanted one, nearest first; for a slot_taken answer.
export function nearest(o, wanted, n = 3) {
  const all = openSlots({ ...o, from: o.now, to: o.now + o.type.horizon * DAY });
  return all
    .map((s) => s.start)
    .sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b)
    .slice(0, n);
}
