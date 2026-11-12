'use strict';
// Pure preparation input. Diagnostics stay opt-in and the serving module owns
// its fixed schema/bounds; this binding records the selected profile explicitly.
function selection(source = process.env) {
  const enabled = source.NS_M7_DIAGNOSTICS === undefined ? '0' : source.NS_M7_DIAGNOSTICS;
  const interval = source.NS_M7_DIAGNOSTICS_INTERVAL_MS === undefined ? '5000' : source.NS_M7_DIAGNOSTICS_INTERVAL_MS;
  if (!['0','1'].includes(enabled) || typeof interval !== 'string' || !/^[1-9][0-9]*$/.test(interval) || Number(interval) < 1000 || Number(interval) > 60000) throw new TypeError('Explicit bounded M7 diagnostics selection required');
  return { enabled, interval };
}
module.exports = { selection };
