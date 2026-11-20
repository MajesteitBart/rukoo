'use strict';

// fs for the browser build. The chat cache lives in memory (src/web/engine/sqlite.js), so no file is ever written.
// store.js and the WorkspaceService (src/main/workspaces/index.js) only ask whether the cache file or its -wal and
// -shm files exist, delete them, and make their folder: none exists, so there is nothing to delete or make, and a
// wipe always reports that no file stayed behind.
module.exports = {
  existsSync: () => false,
  rmSync: () => undefined,
  mkdirSync: () => undefined
};
