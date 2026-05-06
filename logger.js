// logger.js
// Lightweight, zero-dependency structured logger with a ring buffer

(function(global) {
  const DEBUG_MODE = true; // Set to false to silence debug logs
  const MAX_LOGS = 50;

  class Logger {
    constructor() {
      this.buffer = [];
      this.initialized = false;
      this.initBuffer();
    }

    async initBuffer() {
      // Try to load existing logs from session storage if available
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        try {
          const data = await chrome.storage.session.get('logs');
          this.buffer = data.logs || [];
        } catch (e) {
          // session storage might not be accessible (e.g. content script in older Chrome)
        }
      }
      this.initialized = true;
    }

    async _writeLog(level, context, message, data = null) {
      if (level === 'debug' && !DEBUG_MODE) return;

      const entry = {
        timestamp: new Date().toISOString(),
        level,
        context,
        message,
        data
      };

      // Console output for immediate visibility
      const consoleMsg = `[${entry.timestamp}] [${level.toUpperCase()}] [${context}] ${message}`;
      if (level === 'error') {
        console.error(consoleMsg, data || '');
      } else if (level === 'warn') {
        console.warn(consoleMsg, data || '');
      } else if (level === 'info') {
        console.info(consoleMsg, data || '');
      } else {
        console.debug(consoleMsg, data || '');
      }

      // Add to memory ring buffer
      this.buffer.push(entry);
      if (this.buffer.length > MAX_LOGS) {
        this.buffer.shift();
      }

      // Persist to session storage so logs survive popup closes
      if (this.initialized && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        try {
          await chrome.storage.session.set({ logs: this.buffer });
        } catch (e) {
          // Silently fail if storage.session isn't available
        }
      }
    }

    debug(context, message, data) { this._writeLog('debug', context, message, data); }
    info(context, message, data) { this._writeLog('info', context, message, data); }
    warn(context, message, data) { this._writeLog('warn', context, message, data); }
    error(context, message, data) { this._writeLog('error', context, message, data); }

    async flush() {
      let currentLogs = this.buffer;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        try {
          const data = await chrome.storage.session.get('logs');
          currentLogs = data.logs || this.buffer;
        } catch (e) {}
      }
      return JSON.stringify(currentLogs, null, 2);
    }
  }

  // Export globally
  global.logger = new Logger();
})(globalThis);
