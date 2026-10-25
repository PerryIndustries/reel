// node:sqlite still prints an ExperimentalWarning on Node 25; drop just that one warning.
// Imported before node:sqlite (see db.js); every other warning is still printed.
const listeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w?.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  for (const l of listeners) l(w);
});
