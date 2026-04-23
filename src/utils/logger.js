'use strict';

function ts() {
  return new Date().toISOString();
}

function log(level, ...args) {
  const line = `[${ts()}] [${level.toUpperCase()}]`;
  if (level === 'error') console.error(line, ...args);
  else console.log(line, ...args);
}

module.exports = {
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  debug: (...a) => process.env.LOG_LEVEL === 'debug' && log('debug', ...a),
};
