// Fold against the first frame of each group, so a slow change cannot drift through many
// nearly identical frames and hide a new slide. Missing OCR stays separate until it is known.
export function foldFrames(frames) {
  const words = (f) => typeof f.text === 'string' && !f.textOmitted
    ? new Set(f.text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []) : null;
  const title = (f) => f.text.split('\n').map((line) => line.trim().toLowerCase()).find(Boolean) || '';
  const groups = [];
  for (const f of frames) {
    const tokens = words(f);
    const last = groups.at(-1);
    const anchor = last && words(last[0]);
    const shared = tokens && anchor ? [...tokens].filter((w) => anchor.has(w)).length : 0;
    const union = tokens && anchor ? new Set([...tokens, ...anchor]).size : 0;
    const same = tokens && anchor && title(f) === title(last[0]) && (!union || shared / union >= 0.8);
    if (same) last.push(f);
    else groups.push([f]);
  }
  return groups;
}
