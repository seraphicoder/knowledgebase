// Minimal structured logger. Console is acceptable for Phase 1 (see kickoff
// "Questions To Ask"). Swap for pino/etc. without touching call sites.

type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields): void {
  const line = { level, msg, ts: new Date().toISOString(), ...fields };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};
