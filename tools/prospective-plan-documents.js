#!/usr/bin/env node
'use strict';

// The Compose plan's role documents in the form core's deployment plan contract
// takes them (cgm-remote-monitor docs/multitenant-plan-contract.md,
// `nightscout plan check`): one entry per role process, with the roles it
// serves, its environment, and the JSON files that environment names, at the
// paths the containers read them (registry-bootstrap.js writes the same
// documents under <state>/<service>/, mounted at /run/ns-config).
//
//   node tools/prospective-plan-documents.js      prints the document set for the selected topology
//                               (NS_API_REPLICAS, NS_EVALUATOR_WORKERS as the plan reads them)
//
// Connection addresses are synthetic placeholders: the contract check parses
// them and dials nothing. The ui service is this repository's own (ui.js) and
// has no core role document. A selected realtime placement
// (NS_REALTIME_WORKERS) is refused here: its published maps are written by the
// placement tools at run time, outside the plan's documents.
const plan = require('../deploy/multitenant/config');

const CONFIG = '/run/ns-config/';
const product = service => service.startsWith('api-') ? 'api' : service.startsWith('realtime-') ? 'realtime' : service.startsWith('evaluator-') ? 'evaluator' : service;

function documentSet (docs) {
  if (docs.realtimePlacement) throw new TypeError('PLAN_DOCUMENTS_PLACEMENT_UNSUPPORTED');
  const processes = Object.keys(docs.configs).map(service => ({ name: service, roles: [product(service)], environment: docs.environments[service],
    files: { [CONFIG + 'config.json']: docs.configs[service], [CONFIG + 'operation.json']: docs.operations[service],
      ...(product(service) === 'api' ? { [CONFIG + 'evaluator-metadata.json']: docs.configs.evaluator } : {}) } }));
  processes.push({ name: 'admin', roles: ['admin'], environment: docs.admin.environment, files: { [CONFIG + 'config.json']: docs.admin.config } });
  processes.push({ name: 'feed-reader', roles: ['feed-reader'], environment: docs.feed.environment, files: { [CONFIG + 'config.json']: docs.feed.config } });
  return { contract: 1, processes };
}

// The plan's registry-mode documents with a placeholder address for every database identity.
function generated () {
  if (require('../deploy/multitenant/realtime-workers').selection()) throw new TypeError('PLAN_DOCUMENTS_PLACEMENT_UNSUPPORTED');
  const layout = plan.layout();
  const urls = Object.fromEntries(Object.keys(layout.roles).map(kind => [kind, 'postgres://' + layout.roles[kind] + ':placeholder@postgres:5432/nightscout_compose_test']));
  return plan.documents({ layout, urls, tokens: [], publicKeys: [], managementKeys: [], vaultAddress: 'https://vault:8200', registryMode: true });
}

if (require.main === module) process.stdout.write(JSON.stringify(documentSet(generated())) + '\n');
module.exports = { documentSet, generated };
