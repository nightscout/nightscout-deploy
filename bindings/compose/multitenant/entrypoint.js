'use strict';

require('./load-env');
const role = process.argv[2];
if (!['api', 'realtime', 'evaluator', 'tenant-admin', 'admin', 'feed-reader'].includes(role) || process.argv.length !== 3) {
  process.stderr.write('Select one multitenant service role\n');
  process.exit(64);
}
if(role==='feed-reader'&&process.env.NS_PGSTREAM==='1'){process.stdout.write('pgstream is owned by evaluator; legacy reader disabled\n');}else require('../../lib/cli').main(['multitenant', role]);
