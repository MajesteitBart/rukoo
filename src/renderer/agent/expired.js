// A request from main that it has stopped waiting for (the panel was still loading): acting on it now would change
// the composer after the tool already reported that it failed.
export function expired(request, now = Date.now()) {
  return Boolean(request && request.deadline) && now > request.deadline;
}
