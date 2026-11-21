'use strict';

// src/main/account/client.js for the browser build. wire.js takes only AccountError from it, to recognise an account
// server's refusal (wire.js chatError); files.js also takes errorDetails, for the server's answer to a transfer it
// makes itself (an upload's PUT, a download link that expired). The rest of that file is Node's http client. Both are
// the web account's own (src/web/account/client.js), so an error from the page's account service is an AccountError
// here too and instanceof holds on both sides of the bundle. chatError also accepts any error with a string code and a
// numeric status.
const web = require('../../account/client');

// files.js passes the answer of shims/http.js, whose headers are a plain object of lowercase names, as Node's are.
const errorDetails = (json, res) => web.errorDetails(json, res && res.headers);

module.exports = { AccountError: web.AccountError, errorDetails };
