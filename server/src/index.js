require('dotenv').config();
const connectDB = require('./db');
const { startScheduler } = require('./jobs/scheduler');

// "Log and restart": an unhandled rejection or uncaught exception means a bug
// we didn't catch and process state may be corrupt, so we log the full stack,
// stop accepting new connections, and exit non-zero. The supervisor (run.js)
// then starts a fresh process. The logged stack is the thing to actually fix.
let httpServer = null;
let shuttingDown = false;
function fatal(label, err) {
  console.error(`[${label}]`, err?.stack || err);
  if (shuttingDown) return;       // a second fault while draining — let exit proceed
  shuttingDown = true;
  const done = () => process.exit(1);
  if (httpServer) {
    httpServer.close(done);
    setTimeout(done, 5000).unref();   // force-exit if connections don't drain
  } else {
    done();
  }
}
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => fatal('uncaughtException', err));

// Required after dotenv so route modules see the env (API keys, CORS origins).
const app = require('./app');

const PORT = process.env.PORT || 3001;

connectDB().then(() => {
  httpServer = app.listen(PORT, () => {
    console.log(`Calen server running on port ${PORT}`);
    startScheduler();
  });
  // Real-time record-change pokes: the WebSocket endpoint rides the same HTTP
  // server (upgrade on /api/records/ws); the change stream catches writes from
  // other instances/scripts (no-ops gracefully off a replica set).
  require('./services/recordSocket').attachRecordSocket(httpServer);
  require('./services/recordChanges').startChangeStream();
});
