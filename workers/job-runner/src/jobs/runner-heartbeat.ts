/**
 * Runner heartbeat job: runs in its own Bree worker thread, once per tick.
 * Deliberately dependency-free and side-effect-free apart from one log
 * line, so a failure here can only mean the runner itself is broken.
 * It proves the scheduler is alive in pm2 logs.
 */
const startedAt = new Date().toISOString();
console.log(`[job-runner] heartbeat tick at ${startedAt} (worker pid ${process.pid})`);
