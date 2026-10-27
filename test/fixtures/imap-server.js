'use strict';

// An IMAP server for sign-in tests, over plain TCP on this PC. It greets, answers CAPABILITY and answers LOGIN with
// the response it was given, such as Gmail's refusal of a normal Google password. Any other command gets OK. It only
// reads single-line commands, which is all a LOGIN with a plain username and password takes.
const net = require('net');

// login: the status and text after the tag in the answer to LOGIN.
function imapServer({ login = 'OK LOGIN completed' } = {}) {
  const sockets = new Set();
  const logins = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.write('* OK [CAPABILITY IMAP4rev1] Test server ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, command = ''] = line.split(' ');
        switch (command.toUpperCase()) {
          case 'CAPABILITY':
            socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
            break;
          case 'LOGIN':
            logins.push(line);
            socket.write(`${tag} ${login}\r\n`);
            break;
          case 'LOGOUT':
            socket.end(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`);
            break;
          default:
            socket.write(`${tag} OK\r\n`);
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        logins,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          })
      })
    );
  });
}

// What Gmail answers to LOGIN with a normal Google password.
const GMAIL_APP_PASSWORD_REQUIRED = 'NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)';

module.exports = { imapServer, GMAIL_APP_PASSWORD_REQUIRED };
