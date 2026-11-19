// Per-role placement of the role processes (decisions k1-per-role-deployments and
// statefulset-ordinal-scaling). api and tenant-admin are one-replica Recreate Deployments.
// evaluator and realtime are StatefulSets: a Pod's slice is its ordinal (the pod-index label,
// through the downward API) and K is NS_SLICE_COUNT, rendered from the same value that sets the
// replica count (c.slices.<role>). A K change is an ordinary rolling update triggered by that
// env change. A Pod whose ordinal is at or above K owns no tenant (core hashes tenant mod K).
// The evaluator stays at K=1: pgstream delivers to one receiver, and this binding does not
// support evaluator K>1.
{
  ports:: { api: 19001, evaluator: 19002, realtime: 19003, 'tenant-admin': 19004 },
  // The routing proxy that sends a tenant's realtime connections to its owning Pod
  // (compose static-ownership.js, conformance-tested against core slice.js). Realtime K>1 only.
  socketEdgePort:: 1343,
  ordinal:: ['realtime', 'evaluator'],
  render(raw, c)::
    local roles = std.objectFields($.ports);
    local k = c.slices.realtime;
    assert c.slices.evaluator == 1 : 'evaluator K>1 is not supported: pgstream delivers to one receiver';
    assert std.isNumber(k) && k == std.floor(k) && k >= 1 && k <= 8 : 'slices.realtime must be an integer 1..8';
    local label(role) = { 'app.kubernetes.io/name': 'nightscout', 'app.kubernetes.io/part-of': 'nightscout-multitenant', 'app.kubernetes.io/component': role };
    local meta(name, role) = { name: name, namespace: c.namespace, labels: label(role) };
    local source = raw.roleTemplate.spec;
    // Pod DNS names under the realtime governing (headless) Service.
    local realtimePod(i, port) = 'http://realtime-' + i + '.realtime-peers.' + c.namespace + '.svc:' + port + '/';
    local sliceEnv(role) =
      if role == 'realtime' then [
        { name: 'NS_SLICE_ORDINAL', valueFrom: { fieldRef: { fieldPath: "metadata.labels['apps.kubernetes.io/pod-index']" } } },
        { name: 'NS_SLICE_COUNT', value: std.toString(k) },
      ] else if role == 'evaluator' && k > 1 then [
        // The evaluator hints each realtime owner directly, in ordinal order.
        { name: 'NS_REALTIME_SLICE_PEERS', value: std.manifestJsonMinified([{ url: realtimePod(i, $.ports.realtime) } for i in std.range(0, k - 1)]) },
      ] else [];
    local spec(role) =
      local agent = role == 'api';
      local keep = ['secret-' + role, 'ns-ca', 'tmp'] +
                   (if agent then ['ns-vault', 'vault-token', 'vault-agent-config'] else []);
      local key = std.asciiUpper(std.strReplace(role, '-', '_'));
      local publicPorts = { api: '1337', realtime: '1339', 'tenant-admin': '1341' };
      local env = [
        { name: 'NS_SERVE_INTERNAL_HOST', value: '0.0.0.0' },
        { name: 'NS_SERVE_INTERNAL_PORT', value: std.toString($.ports[role]) },
      ] + [{ name: 'NS_' + std.asciiUpper(std.strReplace(peer, '-', '_')) + '_INTERNAL_URL',
             value: 'http://' + peer + '-internal:' + std.toString($.ports[peer]) + '/' } for peer in roles]
        + (if std.objectHas(publicPorts, role) then [
              { name: key + '_HOSTNAME', value: '0.0.0.0' }, { name: key + '_PORT', value: publicPorts[role] },
           ] else [])
        + (if std.member(['api', 'tenant-admin'], role) then [{ name: 'NS_VAULT_ADDR', value: 'https://vault:8200' }] else [])
        + (if agent then [{ name: 'NS_VAULT_TOKEN_FILE', value: '/run/ns-vault/token' }] else []);
      source + {
        initContainers: if agent then [source.initContainers[0]] else [],
        containers: [x + {
          env: x.env + env + sliceEnv(role),
          ports: x.ports + [{ name: 'int-role', containerPort: $.ports[role] }],
          // Core health endpoints on the role's private listener (lib/server/serve/role-health.js).
          // Startup budget 5 s x 180 = 900 s (Compose start_period) for a long tenant warm.
          startupProbe: { httpGet: { path: '/healthz/isolation', port: 'int-role' }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 180 },
          readinessProbe: { httpGet: { path: '/healthz/ready', port: 'int-role' }, periodSeconds: 2, timeoutSeconds: 3, failureThreshold: 30 },
          // Process liveness only: /healthz/live answers while the datastore is down; a role that
          // cannot recover the datastore within its bound exits on its own (datastore-loss-recover-in-place).
          livenessProbe: { httpGet: { path: '/healthz/live', port: 'int-role' }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 },
          volumeMounts: [v for v in x.volumeMounts if std.member(keep, v.name)],
        } for x in source.containers if x.name == role],
        volumes: [v for v in source.volumes if std.member(keep, v.name)],
      };
    local service(name, role, ports, early=false) = {
      apiVersion: 'v1', kind: 'Service', metadata: meta(name, role),
      spec: { type: 'ClusterIP', selector: label(role), ports: ports } +
            (if early then { publishNotReadyAddresses: true } else {}),
    };
    local policy(name, role, callers, ports) = {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(name, 'network'),
      spec: { podSelector: { matchLabels: label(role) }, policyTypes: ['Ingress'], ingress: [{
        from: [{ podSelector: { matchLabels: { 'app.kubernetes.io/component': caller } } } for caller in callers],
        ports: [{ protocol: 'TCP', port: port } for port in ports],
      }] },
    };
    local workload(role) =
      if std.member($.ordinal, role) then {
        apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: meta(role, role),
        spec: {
          replicas: if role == 'realtime' then k else 1,
          serviceName: role + '-peers',
          // Slices carry no start order; Pods start and stop independently.
          podManagementPolicy: 'Parallel',
          updateStrategy: { type: 'RollingUpdate' },
          selector: { matchLabels: label(role) },
          template: { metadata: { labels: label(role) }, spec: spec(role) },
        },
      } else {
        apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(role, role),
        spec: { replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: label(role) },
          template: { metadata: { labels: label(role) }, spec: spec(role) } },
      };
    local routed = k > 1;
    { [key]: raw[key] for key in std.objectFields(raw) if key != 'networkPolicies' } + {
      // One API agent retains its existing policy/sink. Other roles use their
      // existing role-specific private documents and receive no API Vault token.
      roleAuth: { serviceAccount: raw.roleTemplate.serviceAccount, agentConfig: raw.roleTemplate.agentConfig },
      components: {
        [role]: {
          [if std.member($.ordinal, role) then 'statefulset' else 'deployment']: workload(role),
          internal: service(role + '-internal', role, [{ name: 'internal', port: $.ports[role], targetPort: 'int-role' }], true),
        } + (if std.member($.ordinal, role) then {
          peers: {
            apiVersion: 'v1', kind: 'Service', metadata: meta(role + '-peers', role),
            spec: { clusterIP: 'None', publishNotReadyAddresses: true, selector: label(role) },
          },
        } else {}) + (if std.member(['api', 'realtime'], role) then {
          public: service(role, role, [{ name: 'http', port: if role == 'api' then 1337 else 1339, targetPort: 'http-' + role }]),
        } else if role == 'evaluator' then {
          intake: service('evaluator', role, [{ name: 'stream-intake', port: 19913, targetPort: 'stream-intake' }], true),
        } else {}) for role in roles
      },
      [if routed then 'socketEdge']: {
        // Compose: socket-edge extends ui (same documents and registry reader, another command).
        local ui = raw.ui.deployment,
        local upstreams = [realtimePod(i, 1339) for i in std.range(0, k - 1)],
        deployment: ui + {
          metadata: meta('socket-edge', 'socket-edge'),
          spec+: { selector: { matchLabels: label('socket-edge') }, template+: {
            metadata: { labels: label('socket-edge') },
            spec+: { containers: [x + {
              command: ['node', '-r', './deploy/multitenant/load-env.js', 'deploy/multitenant/socket-edge.js'],
              env+: [
                { name: 'NS_REALTIME_STATIC_COUNT', value: std.toString(k) },
                { name: 'NS_REALTIME_STATIC_ROUTE_MAP', value: std.manifestJsonMinified({ version: 1, rule: 'sha256-modulo-v1', count: k, upstreams: upstreams }) },
              ],
              ports: [{ name: 'http-socket', containerPort: $.socketEdgePort }],
              readinessProbe: { httpGet: { path: '/healthz', port: 'http-socket' }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 },
            } for x in ui.spec.template.spec.containers] },
          } },
        },
        service: service('socket-edge', 'socket-edge', [{ name: 'http', port: $.socketEdgePort, targetPort: 'http-socket' }]),
      },
      [if routed then 'edge']: raw.edge + {
        config+: { data: { 'nginx.conf': std.strReplace(raw.edge.config.data['nginx.conf'], 'upstream realtime { server realtime:1339; }', 'upstream realtime { server socket-edge:' + $.socketEdgePort + '; }') } },
      },
      networkPolicies: {
        [key]: raw.networkPolicies[key] for key in std.objectFields(raw.networkPolicies)
        if !std.member(['postgresFromApp', 'vaultFromApp'], key)
      } + {
        // Private role contracts; no public/edge Pod reaches these ports.
        [role + '-internal']: policy(role + '-internal', role, roles + ['operator'], [$.ports[role]]) for role in roles
      } + {
        apiPublic: policy('api-public', 'api', ['edge', 'operator'], [1337]),
        realtimePublic: policy('realtime-public', 'realtime', ['edge', 'operator'] + (if routed then ['socket-edge'] else []), [1339]),
        evaluatorIntake: policy('evaluator-intake', 'evaluator', ['pgstream'], [19913]),
        postgresFromApp: policy('postgres-from-app', 'postgres', roles + ['pgstream', 'admin', 'ui', 'provision'] + (if routed then ['socket-edge'] else []), [5432]),
        vaultFromApp: policy('vault-from-app', 'vault', ['api', 'tenant-admin', 'admin', 'provision', 'vault'], [8200]),
      } + (if routed then {
        socketEdgeFromEdge: policy('socket-edge-from-edge', 'socket-edge', ['edge'], [$.socketEdgePort]),
      } else {}),
    },
}
