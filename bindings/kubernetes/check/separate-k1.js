'use strict';
const { PORTS, ROLES } = require('../ops/network-documents.cjs');
function check(all, inventory, fail) {
  const workloads = all.filter(x => ['Deployment', 'StatefulSet', 'Job'].includes(x.kind));
  const want = [...ROLES, 'postgres', 'vault', 'pgstream', 'admin', 'ui', 'edge', 'provision', 'primer'].sort();
  if (JSON.stringify(workloads.map(x => x.metadata.name).sort()) !== JSON.stringify(want)) fail('separate-k1 requires twelve exact workloads');
  const component = 'app.kubernetes.io/component';
  const policies = all.filter(x => x.kind === 'NetworkPolicy');
  const matches = (selector, labels) => Object.entries(selector?.matchLabels || {}).every(([k, v]) => labels[k] === v);
  for (const role of ROLES) {
    const w = workloads.find(x => x.metadata.name === role);
    if (!w || w.kind !== 'Deployment' || w.spec.replicas !== 1 || w.spec.strategy?.type !== 'Recreate') { fail(role + ' requires one Recreate Deployment'); continue; }
    const spec = w.spec.template.spec, containers = spec.containers;
    if (containers.length !== 1 || containers[0].name !== role) fail(role + ' must run only its own application process');
    if (spec.volumes.some(x => x.name === 'ns-ipc') || containers.some(x => x.volumeMounts.some(v => v.name === 'ns-ipc'))) fail(role + ' must not mount ns-ipc');
    if (!containers[0].ports.some(p => p.name === 'int-role' && p.containerPort === PORTS[role])) fail(role + ' requires its declared private port');
    if ((spec.initContainers || []).filter(x => x.name === 'vault-agent').length !== (role === 'api' ? 1 : 0)) fail(role + ' Vault Agent scope differs from its token requirement');
    if (spec.volumes.filter(x => x.secret && x.secret.secretName.startsWith('ns-config-')).some(x => x.secret.secretName !== 'ns-config-' + role)) fail(role + ' mounts another role credential');
    const service = all.find(x => x.kind === 'Service' && x.metadata.name === role + '-internal');
    if (!service || service.spec.type !== 'ClusterIP' || service.spec.selector?.[component] !== role || service.spec.ports.length !== 1 ||
        service.spec.ports[0].port !== PORTS[role] || service.spec.ports[0].targetPort !== 'int-role' || service.spec.publishNotReadyAddresses !== true) fail(role + ' requires its early private ClusterIP Service');
    // NetworkPolicies add their allowances. Inspect every matching policy so a
    // second permissive rule cannot silently defeat the directed private rule.
    const allowed = new Set();
    for (const p of policies.filter(p => matches(p.spec.podSelector, w.spec.template.metadata.labels))) {
      for (const rule of p.spec.ingress || []) {
        if (rule.ports?.length && !rule.ports.some(p => p.port === PORTS[role] || p.port === 'int-role')) continue;
        if (!rule.from?.length) fail(role + ' private ingress admits all sources');
        for (const peer of rule.from || []) {
          const source = peer.podSelector?.matchLabels?.[component];
          if (peer.ipBlock || peer.namespaceSelector || ![...ROLES, 'operator'].includes(source) || peer.podSelector?.matchExpressions) fail(role + ' private ingress admits an unauthorized source');
          else allowed.add(source);
        }
      }
    }
    if ([...ROLES, 'operator'].some(source => !allowed.has(source))) fail(role + ' lacks a directed lifecycle ingress path');
  }
  for (const service of all.filter(x => x.kind === 'Service')) {
    if ((service.spec.ports || []).some(p => p.targetPort === 'int-role') && !ROLES.some(role => service.metadata.name === role + '-internal')) fail('private role port is published by ' + service.metadata.name);
  }
  if (inventory.evaluatorPool.partition !== 'off') fail('separate-k1 supports the native single evaluator');
  const defaultDeny = policies.find(x => x.metadata.name === 'default-deny-ingress');
  if (!defaultDeny || Object.keys(defaultDeny.spec.podSelector || {}).length || defaultDeny.spec.ingress?.length || !defaultDeny.spec.policyTypes.includes('Ingress')) fail('separate-k1 requires namespace default deny ingress');
}
module.exports = { check };
