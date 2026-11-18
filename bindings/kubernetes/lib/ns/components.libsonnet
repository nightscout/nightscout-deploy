// K=1 placement of the existing role processes. Application contracts and
// participant incarnation checks stay in core; this projection owns reachability.
{
  ports:: { api: 19001, evaluator: 19002, realtime: 19003, 'tenant-admin': 19004 },
  render(raw, c)::
    local roles = std.objectFields($.ports);
    local label(role) = { 'app.kubernetes.io/name': 'nightscout', 'app.kubernetes.io/part-of': 'nightscout-multitenant', 'app.kubernetes.io/component': role };
    local meta(name, role) = { name: name, namespace: c.namespace, labels: label(role) };
    local source = raw.cohort.statefulset.spec.template.spec;
    local spec(role) =
      local agent = role == 'api';
      local keep = ['secret-' + role, 'config-' + role, 'ns-ca', 'tmp'] +
                   (if agent then ['ns-vault', 'vault-token', 'vault-agent-config'] else []);
      local init = source.initContainers[0];
      source + {
        initContainers: [init + {
          command: std.slice(init.command, 0, 3, 1) + [role],
          volumeMounts: [v for v in init.volumeMounts if std.member(['secret-' + role, 'config-' + role], v.name)],
        }] + (if agent then [source.initContainers[1]] else []),
        containers: [x + {
          ports: x.ports + [{ name: 'int-role', containerPort: $.ports[role] }],
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
    { [key]: raw[key] for key in std.objectFields(raw) if !std.member(['cohort', 'networkPolicies'], key) } + {
      // One API agent retains its existing policy/sink. Other roles use their
      // existing role-specific private documents and receive no API Vault token.
      roleAuth: { serviceAccount: raw.cohort.serviceAccount, agentConfig: raw.cohort.agentConfig },
      components: {
        [role]: {
          deployment: {
            apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(role, role),
            spec: { replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: label(role) },
              template: { metadata: { labels: label(role) }, spec: spec(role) } },
          },
          internal: service(role + '-internal', role, [{ name: 'internal', port: $.ports[role], targetPort: 'int-role' }], true),
        } + (if std.member(['api', 'realtime'], role) then {
          public: service(role, role, [{ name: 'http', port: if role == 'api' then 1337 else 1339, targetPort: 'http-' + role }]),
        } else if role == 'evaluator' then {
          intake: service('evaluator', role, [{ name: 'stream-intake', port: 19913, targetPort: 'stream-intake' }], true),
        } else {}) for role in roles
      },
      networkPolicies: {
        [key]: raw.networkPolicies[key] for key in std.objectFields(raw.networkPolicies)
        if !std.member(['cohortFromEdge', 'cohortFromOperator', 'cohortFromPgstream', 'postgresFromApp', 'vaultFromApp'], key)
      } + {
        // The operation cohort calls each actual role and pins its incarnation.
        // No public/edge Pod has access to these private contract ports.
        [role + '-internal']: policy(role + '-internal', role, roles + ['operator'], [$.ports[role]]) for role in roles
      } + {
        apiPublic: policy('api-public', 'api', ['edge', 'operator'], [1337]),
        realtimePublic: policy('realtime-public', 'realtime', ['edge', 'operator'], [1339]),
        evaluatorIntake: policy('evaluator-intake', 'evaluator', ['pgstream'], [19913]),
        postgresFromApp: policy('postgres-from-app', 'postgres', roles + ['pgstream', 'admin', 'ui', 'provision'], [5432]),
        vaultFromApp: policy('vault-from-app', 'vault', ['api', 'tenant-admin', 'admin', 'provision', 'vault'], [8200]),
      },
    },
}
