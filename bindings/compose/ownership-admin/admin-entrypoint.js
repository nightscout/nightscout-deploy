'use strict';

// Starts the `admin` role. The imported entrypoint.js names four roles and not this one, so the
// overlay starts it the same way (private environment document, then core's CLI) without editing
// the imported file. The environment document is /run/ns-config/env.json, as for every role.
require('/opt/app/deploy/multitenant/load-env');
require('/opt/app/lib/cli').main(['multitenant', 'admin']);
