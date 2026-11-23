// The vcpool role (core MT-CONNECTOR-REVERSE: the tenant-side Nightscout connector). Off by default;
// off, nothing here renders and the namespace is byte-identical to a render without this file
// (check/vcpool.test.js). On (vcpool.enabled):
//   - StatefulSet `vcpool`, one replica. Core runs vcpool pool membership flag off
//     (lib/server/serve/vcpool-preview.js `partitioned: false`; lib/pool-membership/index.js: no role
//     setting selects partitioned membership), so one member owns every connector tenant and a
//     second live member would pull the same tenants. A StatefulSet keeps at most one Pod per
//     ordinal: on a Pod delete or eviction the replacement starts only after the old Pod is gone,
//     where a Deployment's ReplicaSet (Recreate covers rollouts only) starts the replacement at once.
//     Replicas is not an input; a partitioned pool is a core change first.
//   - its private listener on 19005 (health, connector-inspection, and /metrics with labMetrics or
//     vcpool.metrics), Service `vcpool-internal`;
//   - environment: NS_VCPOOL_API_URL (the api Service; the tenant is chosen by Host),
//     NS_VCPOOL_ALLOW_HOSTS, NS_VCPOOL_ALLOW_INSECURE_HTTP, MULTITENANT_VCPOOL_EGRESS_PROXY when set,
//     NS_VAULT_ADDR; credentials from Secret ns-config-vcpool (scripts/secrets.sh with NS_VCPOOL=1);
//   - provisioning: the bootstrap step mounts ns-credentials-vcpool and creates the two vcpool logins,
//     their grants and the decrypt-only Vault token (compose/multitenant/vcpool.js);
//   - a suspended operator Job `connector-entry` (compose/multitenant/connector-entry.js) that enters,
//     from Secret ns-connector-entry, the connector subject (tenant root API), the three secrets
//     (admin PUT /v1/tenants/{id}/secrets/{ref}, decision connector-secret-entry-admin) and the
//     definition (admin connector-sources); it holds no database or Vault credential;
//   - NetworkPolicy: vcpool reaches postgres, vault and the api's public port; connector-entry is an
//     operator Pod (admin and the api's public port admit operators). Egress to sources is not restricted here (policies
//     are ingress only); a source in the namespace admits vcpool with its own policy.
// Connection budget: one Pod × (secrets 4 + activity 2 + registry view 2 + definitions 2) = 10,
// plus the transient readiness clients (connection-budget.libsonnet).
{
  defaults:: {
    enabled: false,
    allowHosts: [],
    allowInsecureHttp: false,
    egressProxy: null,
    metrics: false,
  },
  port:: 19005,
  fixedPool:: 10,

  settings(c):: std.mergePatch($.defaults, std.get(c, 'vcpool', {})),
  enabled(c):: $.settings(c).enabled == true,
  pods(c):: if $.enabled(c) then 1 else 0,
  // Extra components admitted to postgres, vault and the api's public port. The connector-entry Pod
  // is an operator Pod: admin and the api's public port already admit operators.
  callers(c):: if $.enabled(c) then ['vcpool'] else [],

  check(c)::
    local s = $.settings(c);
    assert std.isBoolean(s.enabled) : 'vcpool.enabled must be a boolean';
    assert !s.enabled || (std.isArray(s.allowHosts) && std.length(s.allowHosts) > 0 &&
      std.length([h for h in s.allowHosts if !(std.isString(h) && std.length(h) > 0 && std.length(h) <= 253 && std.asciiLower(h) == h)]) == 0) :
      'vcpool.allowHosts must list at least one lower-case source host name when vcpool is enabled';
    assert std.isBoolean(s.allowInsecureHttp) && std.isBoolean(s.metrics) : 'vcpool.allowInsecureHttp and vcpool.metrics must be booleans';
    assert std.get(s, 'egressProxy', null) == null || std.isString(s.egressProxy) : 'vcpool.egressProxy must be null or an http(s) origin';
    true,

  // Provision Job patch: the bootstrap step also mounts the vcpool credentials.
  provision(job, c)::
    if !$.enabled(c) then job else job + { spec+: { template+: { spec+: {
      initContainers: [x + (if x.name == 'bootstrap' then { volumeMounts+: [{ name: 'credentials-vcpool', mountPath: '/run/ns-credentials/vcpool', readOnly: true }] } else {})
                       for x in super.initContainers],
      volumes+: [{ name: 'credentials-vcpool', secret: { secretName: 'ns-credentials-vcpool', defaultMode: 288 } }],
    } } } },

  // roleTemplate: the shared role Pod spec (nightscout.libsonnet); label/meta from components.
  render(c, raw, meta, label, service, policy, labEnv)::
    local s = $.settings(c);
    local template = raw.roleTemplate.spec;
    local base = [x for x in template.containers if x.name == 'api'][0];
    local hardened = base.securityContext;
    local keep = ['ns-ca', 'tmp'];
    local spec = {
      serviceAccountName: template.serviceAccountName,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: template.securityContext,
      terminationGracePeriodSeconds: template.terminationGracePeriodSeconds,
      containers: [{
        name: 'vcpool',
        image: base.image,
        imagePullPolicy: 'IfNotPresent',
        command: ['node', 'deploy/multitenant/entrypoint.js', 'vcpool'],
        env: [
          { name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' },
          { name: 'NS_SERVE_INTERNAL_HOST', value: '0.0.0.0' },
          { name: 'NS_SERVE_INTERNAL_PORT', value: std.toString($.port) },
          { name: 'NS_VAULT_ADDR', value: 'https://vault:8200' },
          { name: 'NS_VCPOOL_API_URL', value: 'http://api:1337' },
          { name: 'NS_VCPOOL_ALLOW_HOSTS', value: std.join(',', s.allowHosts) },
          { name: 'NS_VCPOOL_ALLOW_INSECURE_HTTP', value: if s.allowInsecureHttp then 'true' else 'false' },
        ] + (if std.get(s, 'egressProxy', null) != null then [{ name: 'MULTITENANT_VCPOOL_EGRESS_PROXY', value: s.egressProxy }] else [])
          + (if s.metrics && labEnv == [] then [{ name: 'NS_METRICS', value: 'true' }] else labEnv),
        ports: [{ name: 'int-role', containerPort: $.port }],
        startupProbe: { httpGet: { path: '/healthz/isolation', port: 'int-role' }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 180 },
        readinessProbe: { httpGet: { path: '/healthz/ready', port: 'int-role' }, periodSeconds: 2, timeoutSeconds: 3, failureThreshold: 30 },
        livenessProbe: { httpGet: { path: '/healthz/live', port: 'int-role' }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 },
        securityContext: hardened,
        volumeMounts: [{ name: 'secret-vcpool', mountPath: '/run/ns-config', readOnly: true }] + [v for v in base.volumeMounts if std.member(keep, v.name)],
      }],
      volumes: [{ name: 'secret-vcpool', secret: { secretName: 'ns-config-vcpool', defaultMode: 288 } }] + [v for v in template.volumes if std.member(keep, v.name)],
    };
    local entry = {
      apiVersion: 'batch/v1', kind: 'Job', metadata: meta('connector-entry', 'operator'),
      spec: { suspend: true, backoffLimit: 0, activeDeadlineSeconds: c.provisionDeadlineSeconds,
        template: { metadata: { labels: label('operator') }, spec: {
          restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
          securityContext: template.securityContext,
          containers: [{
            name: 'connector-entry', image: base.image, imagePullPolicy: 'IfNotPresent', securityContext: hardened,
            command: ['node', 'deploy/multitenant/connector-entry.js'],
            env: [
              { name: 'NS_PRIMER_STATE', value: '/run/ns-client' },
              { name: 'NS_CONNECTOR_ENTRY_INPUT', value: '/run/ns-connector-entry/input.json' },
              { name: 'NS_CONNECTOR_API_ORIGIN', value: 'http://api:1337' },
              { name: 'NS_CONNECTOR_ADMIN_ORIGIN', value: 'http://admin:1342' },
            ],
            volumeMounts: [
              { name: 'entry-input', mountPath: '/run/ns-connector-entry', readOnly: true },
              { name: 'client-state', mountPath: '/run/ns-client', readOnly: true },
            ] + [v for v in base.volumeMounts if std.member(['tmp'], v.name)],
          }],
          volumes: [
            { name: 'entry-input', secret: { secretName: 'ns-connector-entry', defaultMode: 288 } },
            { name: 'client-state', persistentVolumeClaim: { claimName: 'primer-results', readOnly: true } },
          ] + [v for v in template.volumes if std.member(['tmp'], v.name)],
        } },
      },
    };
    {
      statefulset: {
        apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: meta('vcpool', 'vcpool'),
        spec: {
          replicas: 1,
          serviceName: 'vcpool-internal',
          podManagementPolicy: 'OrderedReady',
          updateStrategy: { type: 'RollingUpdate' },
          selector: { matchLabels: label('vcpool') },
          template: { metadata: { labels: label('vcpool') }, spec: spec },
        },
      },
      internal: service('vcpool-internal', 'vcpool', [{ name: 'internal', port: $.port, targetPort: 'int-role' }], true),
      policy: policy('vcpool-internal', 'vcpool', ['operator'] + (if labEnv != [] || s.metrics then ['metrics'] else []), [$.port]),
      connectorEntry: entry,
    },
}
