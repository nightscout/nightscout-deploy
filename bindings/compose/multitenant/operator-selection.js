'use strict';

// The private operator uses the same evaluator contract published by admin
// before serving starts. No role discovery or serving database credentials
// are needed on the operator backend.
const { isDeepStrictEqual } = require('node:util');
const platform = require('../../lib/server/serve/platform-verification');
const refused = () => Object.assign(new Error('COMPOSE_OPERATOR_SELECTION_UNVERIFIED'), { code: 'COMPOSE_OPERATOR_SELECTION_UNVERIFIED' });

function inputs (docs, selected) {
  const parser = require('../../lib/server/serve/evaluator-config');
  const listener = require('../../lib/server/internal-api/listener-config');
  const native = require('../../lib/tenant-lifecycle/native-selection');
  const services = require('./evaluator-workers').services(docs.evaluatorWorkers);
  let expected;
  for (const name of services) {
    const config = docs.configs[name], env = docs.environments[name];
    if (!config || !env || !isDeepStrictEqual(docs.operations[name]?.nativeSelection, selected.binding)) throw refused();
    const parsed = parser.parse(config, env, listener.resolve(['evaluator'], env));
    const current = platform.contractInputs(parsed, 'evaluator');
    if (expected && !isDeepStrictEqual(expected, current)) throw refused();
    expected = current;
  }
  native.validate(selected);
  if (!expected) throw refused();
  return expected;
}

function verifier (config) {
  const profile = config.nativeSelection || config.intakeProfile;
  if (!profile && !config.evaluatorProof) return undefined;
  if (!profile || !config.evaluatorProof) throw refused();
  const layout = require('./config').layout(), proof = require('./config').quote(layout.prefix + '_platform_verification');
  const digest = platform.contractFromInputs(config.evaluatorProof, 'evaluator', profile.digest);
  return async query => {
    const result = await query('SELECT /* operator-evaluator-proof */ 1 FROM ' + proof + '.verified_role r JOIN ' + proof + '.verification_control c ON c.singleton AND c.epoch=r.epoch ' +
      "JOIN pg_catalog.pg_database d ON d.datname=current_database() AND d.oid::text=r.database_oid AND d.datname=r.database_name " +
      "JOIN pg_catalog.pg_roles u ON u.oid::text=r.role_oid AND u.rolname=r.role_name " +
      "WHERE r.role='evaluator' AND r.status='verified' AND c.operation_status='IDLE' AND r.contract_digest=$1 AND u.rolname=$2", [digest, layout.roles.evaluator]);
    if (result.rows.length !== 1) throw refused();
  };
}
module.exports = { inputs, verifier };
