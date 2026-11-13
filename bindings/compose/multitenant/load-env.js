'use strict';
// Every actual role entrypoint installs admission after its ordinary private
// environment. Operational readers use service-environment.read directly.
try {
  require('./service-environment').apply();
  require('./connection-budget-runtime').install();
} catch {
  process.stderr.write('Private service environment is missing or invalid\n');
  process.exit(78);
}
