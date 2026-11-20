'use strict';

// http and https for the browser build. Only src/main/account/client.js needs them, and the build replaces that file
// with shims/account-client.js; this keeps any other require of them from failing the build. The browser's requests
// go through the web account service, on fetch.
module.exports = {};
