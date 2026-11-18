'use strict';
// Every actual role entrypoint applies its ordinary private environment.
// Operational readers use service-environment.read directly. Each role's
// configured pool sizes bound its PostgreSQL connections (census C-06).
try {
  require('./service-environment').apply();
} catch {
  process.stderr.write('Private service environment is missing or invalid\n');
  process.exit(78);
}
