'use strict';

// os for the browser build. files.js asks it only for tmpdir(), the folder chatFile 'open' copies a file into before
// the host opens it (src/web/files.js), which here is a name in shims/vfs.js.
module.exports = {
  tmpdir: () => '/tmp',
  platform: () => 'browser',
  EOL: '\n'
};
