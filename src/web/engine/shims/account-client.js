'use strict';

// src/main/account/client.js for the browser build. wire.js takes only AccountError from it, to recognise an account
// server's refusal (wire.js chatError); the rest of that file is Node's http client. This is the web account's own
// class (src/web/account/client.js), so an error from the page's account service is an AccountError here too and
// instanceof holds on both sides of the bundle. chatError also accepts any error with a string code and a numeric
// status.
const { AccountError } = require('../../account/client');

module.exports = { AccountError };
