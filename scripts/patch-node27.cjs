const http = require('node:http');
const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function(event, req, res, ...args) {
  if (event === 'request' && req && req.headers && Object.getPrototypeOf(req.headers) === null) {
    Object.setPrototypeOf(req.headers, Object.prototype);
  }
  return origEmit.call(this, event, req, res, ...args);
};
