// Kubernetes binding of the multitenant Compose tree (../../compose/multitenant).
//
// Same image, same commands, same per-role private documents, same in-container paths. What
// changes is only the binding: Compose services become ordinary Kubernetes resources.
//
//   cohort (StatefulSet, one Pod)  api, realtime, evaluator, tenant-admin containers sharing one
//                                  pod-private emptyDir for serve.internal sockets (/run/ns-ipc),
//                                  plus the Vault Agent as a native sidecar (Kubernetes auth)
//   admin (Deployment)             the ownership-operations plane on its own Pod address and port;
//                                  ClusterIP only, NetworkPolicy admits operator Pods only
//   ui, edge (Deployments)         the shipped pages and the reference nginx (consumer entry)
//   postgres, vault (StatefulSets) the backing stores, same image digests as Compose
//   provision (Job)                imported bootstrap -> Vault Kubernetes auth -> ownership grants
//
// No credential is rendered. Every private document reaches a Pod through a Secret that
// scripts/secrets.sh creates at apply time from generated or provisioned material; this file
// only names the Secrets.
{
  defaults:: {
    namespace: 'nightscout-preview',
    // Deployment prefix of the plan (config.js layout()); PostgreSQL identities are <prefix>_<name>.
    prefix: 'nsdemo',
    // Core commit the image is built from (the Compose tree's SOURCE.md).
    sourceCommit: null,  // required: 40 hex
    images: {
      // The Compose image, built by the Compose tree's build.js and re-tagged by the source
      // commit before it is loaded into the cluster: an exact tag, never :local or :latest.
      app: null,  // required
      // Same digests as ../../compose/multitenant/compose.yaml.
      postgres: 'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
      vault: 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2',
      nginx: 'nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10',
    },
    cohort: {
      // One Pod per cohort. More than one is a second cohort, which the lifecycle locks must
      // refuse (the DEPLOY-K8S-BINDING control); the preview never renders it.
      replicas: 1,
      // Above the serve.internal drain deadline (NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS, default
      // 5000 ms, at most 60000 ms; decision internal-listener-graceful-shutdown).
      terminationGraceSeconds: 30,
    },
    // decisions evaluator-static-partition and pool-primitive-shared: the StatefulSet ordinal is
    // this worker's index, the renderer sets the member count. The core flag (MT-POOL-PRIMITIVE)
    // is not built yet; the variable names are provisional and the preview stays at one member.
    evaluatorPool: {
      members: 1,
      membersEnv: 'NS_EVALUATOR_POOL_MEMBERS',
      ordinalEnv: 'NS_EVALUATOR_POOL_ORDINAL',
    },
    vaultAgent: {
      serviceAccount: 'ns-cohort',
      audience: 'vault',
      tokenTtl: '1h',
      tokenMaxTtl: '24h',
    },
    edge: {
      // ClusterIP plus `kubectl port-forward` is the Compose 127.0.0.1:18080 publication. A
      // LoadBalancer is the operator's choice for a real address.
      serviceType: 'ClusterIP',
      port: 8080,
    },
    storage: { postgres: '1Gi', vault: '256Mi', provisionState: '64Mi' },
  },

  new(overrides):: {
    local c = std.mergePatch($.defaults, overrides),
    local ns = c.namespace,
    assert std.isString(c.sourceCommit) && std.length(c.sourceCommit) == 40 : 'sourceCommit must be the full 40-hex commit',
    assert std.isString(c.images.app) : 'images.app is required',
    assert c.cohort.replicas == 1 : 'the preview renders exactly one cohort Pod',
    assert c.evaluatorPool.members == c.cohort.replicas : 'evaluator pool members must equal the cohort StatefulSet replicas',

    local uid = 1000,
    local part = 'nightscout-multitenant',
    local labels(component) = {
      'app.kubernetes.io/name': 'nightscout',
      'app.kubernetes.io/part-of': part,
      'app.kubernetes.io/component': component,
    },
    local meta(name, component) = { name: name, namespace: ns, labels: labels(component) },

    // Compose: read_only, cap_drop ALL, no-new-privileges, user 1000.
    local hardened = {
      runAsUser: uid,
      runAsGroup: uid,
      runAsNonRoot: true,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    },
    local podSecurity = { fsGroup: uid, seccompProfile: { type: 'RuntimeDefault' } },
    // Compose tmpfs /tmp.
    local tmp = { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
    local tmpMount = { name: 'tmp', mountPath: '/tmp' },
    // The public demo CA (Compose ${NS_DEMO_STATE}/tls/ca.crt), from a Secret made at apply time.
    local ca = { name: 'ns-ca', secret: { secretName: 'ns-ca', defaultMode: 292 } },
    local caMount = { name: 'ns-ca', mountPath: '/run/ns-ca', readOnly: true },

    // Each role's private documents (Compose: ${NS_DEMO_STATE}/<role> mounted read-only at
    // /run/ns-config). Secret volumes are symlinked and group-readable under fsGroup, and
    // load-env.js refuses both, so an init step copies them into a memory-backed emptyDir as
    // regular 0400 files owned by the runtime uid. Kubernetes waits for the Secret to exist.
    local configVolumes(role) = [
      { name: 'secret-' + role, secret: { secretName: 'ns-config-' + role, defaultMode: 288 } },
      { name: 'config-' + role, emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
    ],
    local installConfig(roles) = {
      name: 'install-config',
      image: c.images.app,
      imagePullPolicy: 'IfNotPresent',
      command: ['sh', '-c', 'set -eu; umask 077; for r in "$@"; do cp /run/ns-secret/"$r"/*.json /run/ns-config/"$r"/; done', 'install-config'] + roles,
      securityContext: hardened,
      volumeMounts: std.flattenArrays([
        [{ name: 'secret-' + r, mountPath: '/run/ns-secret/' + r, readOnly: true }, { name: 'config-' + r, mountPath: '/run/ns-config/' + r }]
        for r in roles
      ]),
    },
    local configMount(role) = { name: 'config-' + role, mountPath: '/run/ns-config', readOnly: true },

    local roleContainer(role, ports, extraEnv=[]) = {
      name: role,
      image: c.images.app,
      imagePullPolicy: 'IfNotPresent',
      command: ['node', 'deploy/multitenant/entrypoint.js', role],
      env: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' }] + extraEnv,
      ports: ports,
      // Compose healthcheck: the same script. Readiness only; liveness restarts are a separate
      // decision (shared-process liveness is distinct from tenant admission).
      readinessProbe: { exec: { command: ['node', 'deploy/multitenant/health.js', role] }, periodSeconds: 2, timeoutSeconds: 3, failureThreshold: 30 },
      securityContext: hardened,
      volumeMounts: [
        configMount(role),
        { name: 'ns-ipc', mountPath: '/run/ns-ipc' },
        caMount,
        tmpMount,
        { name: 'ns-vault', mountPath: '/run/ns-vault', readOnly: true },
      ],
    },

    local agentHcl = |||
      # Vault Agent for the Kubernetes binding. Paths only; no credential values.
      # Kubernetes auth (decision vault-agent-sidecar); one role for the deployment
      # (decision vault-one-approle-per-deployment applies to the login identity).
      pid_file = "/tmp/vault-agent.pid"
      disable_mlock = true
      exit_after_auth = false

      vault {
        address = "https://vault:8200"
        ca_cert = "/run/ns-ca/ca.crt"
      }

      auto_auth {
        method "kubernetes" {
          mount_path = "auth/kubernetes"
          config = {
            role = "%(role)s"
            token_path = "/var/run/secrets/vault/token"
          }
        }
        sink "file" {
          config = {
            path = "/run/ns-vault/token"
            mode = 0600
          }
        }
      }
    ||| % { role: c.prefix + '_vault_agent' },

    local vaultHcl = |||
      disable_mlock = true
      ui = false
      api_addr = "https://vault:8200"
      storage "file" { path = "/vault/file" }
      listener "tcp" {
        address = "0.0.0.0:8200"
        tls_cert_file = "/run/ns-tls/server.crt"
        tls_key_file = "/run/ns-tls/server.key"
      }
    |||,

    local cohortRoles = ['api', 'realtime', 'evaluator', 'tenant-admin'],

    namespace: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: { 'app.kubernetes.io/part-of': part } } },

    // ---------------------------------------------------------------- backing stores
    postgres: {
      service: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('postgres', 'postgres'),
        spec: { selector: labels('postgres'), ports: [{ name: 'pg', port: 5432, targetPort: 'pg' }] },
      },
      statefulset: {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata: meta('postgres', 'postgres'),
        spec: {
          serviceName: 'postgres',
          replicas: 1,
          selector: { matchLabels: labels('postgres') },
          template: {
            metadata: { labels: labels('postgres') },
            spec: {
              enableServiceLinks: false,
              automountServiceAccountToken: false,
              containers: [{
                name: 'postgres',
                image: c.images.postgres,
                env: [
                  { name: 'POSTGRES_DB', value: 'nightscout_compose_test' },
                  { name: 'POSTGRES_PASSWORD_FILE', value: '/run/secrets/postgres-password' },
                  // A fresh volume carries lost+found; initdb needs an empty directory.
                  { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
                ],
                ports: [{ name: 'pg', containerPort: 5432 }],
                readinessProbe: { exec: { command: ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres'] }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 },
                volumeMounts: [
                  { name: 'data', mountPath: '/var/lib/postgresql/data' },
                  { name: 'postgres-password', mountPath: '/run/secrets', readOnly: true },
                ],
              }],
              volumes: [{ name: 'postgres-password', secret: { secretName: 'ns-postgres-password', defaultMode: 256 } }],
            },
          },
          volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: c.storage.postgres } } } }],
        },
      },
    },

    vault: {
      serviceAccount: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('vault', 'vault') },
      // Vault reviews the Agent's projected token with its own service-account token.
      tokenReview: {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: ns + '-vault-tokenreview', labels: labels('vault') },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'system:auth-delegator' },
        subjects: [{ kind: 'ServiceAccount', name: 'vault', namespace: ns }],
      },
      config: { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('vault-config', 'vault'), data: { 'demo.hcl': vaultHcl } },
      service: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('vault', 'vault'),
        spec: { selector: labels('vault'), ports: [{ name: 'vault', port: 8200, targetPort: 'vault' }] },
      },
      statefulset: {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata: meta('vault', 'vault'),
        spec: {
          serviceName: 'vault',
          replicas: 1,
          selector: { matchLabels: labels('vault') },
          template: {
            metadata: { labels: labels('vault') },
            spec: {
              enableServiceLinks: false,
              serviceAccountName: 'vault',
              containers: [{
                name: 'vault',
                image: c.images.vault,
                args: ['vault', 'server', '-config=/vault/config/demo.hcl'],
                ports: [{ name: 'vault', containerPort: 8200 }],
                // Compose: status 0 (unsealed) or 2 (sealed) is up; unseal is the provision Job's.
                readinessProbe: { exec: { command: ['sh', '-c', 'vault status -address=https://vault:8200 -ca-cert=/run/ns-ca/ca.crt >/dev/null 2>&1; r=$?; [ "$r" -eq 0 ] || [ "$r" -eq 2 ]'] }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 },
                volumeMounts: [
                  { name: 'data', mountPath: '/vault/file' },
                  { name: 'logs', mountPath: '/vault/logs' },
                  { name: 'tls', mountPath: '/run/ns-tls', readOnly: true },
                  caMount,
                  { name: 'config', mountPath: '/vault/config', readOnly: true },
                ],
              }],
              volumes: [
                { name: 'logs', emptyDir: {} },
                // Compose mounts server.key 0644 because the image drops to its own uid.
                { name: 'tls', secret: { secretName: 'ns-vault-tls', defaultMode: 292, items: [{ key: 'server.crt', path: 'server.crt' }, { key: 'server.key', path: 'server.key' }] } },
                ca,
                { name: 'config', configMap: { name: 'vault-config' } },
              ],
            },
          },
          volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: c.storage.vault } } } }],
        },
      },
    },

    // ---------------------------------------------------------------- the application cohort
    cohort: {
      serviceAccount: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(c.vaultAgent.serviceAccount, 'cohort'), automountServiceAccountToken: false },
      agentConfig: { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('vault-agent-config', 'cohort'), data: { 'agent.hcl': agentHcl } },
      // Governing Service for the StatefulSet: headless, no ports. Nothing internal is published.
      governing: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('cohort', 'cohort'),
        spec: { clusterIP: 'None', selector: labels('cohort') },
      },
      // Consumer Services: the names nginx.conf's upstreams use (api:1337, realtime:1339).
      apiService: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('api', 'cohort'),
        spec: { selector: labels('cohort'), ports: [{ name: 'http', port: 1337, targetPort: 'http-api' }] },
      },
      realtimeService: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('realtime', 'cohort'),
        spec: { selector: labels('cohort'), ports: [{ name: 'http', port: 1339, targetPort: 'http-realtime' }] },
      },
      statefulset: {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata: meta('cohort', 'cohort'),
        spec: {
          serviceName: 'cohort',
          replicas: c.cohort.replicas,
          // With one replica the controller deletes the old Pod and waits for it to terminate
          // before creating the new one: no overlap of two cohort Pods during an update.
          podManagementPolicy: 'OrderedReady',
          updateStrategy: { type: 'RollingUpdate', rollingUpdate: { partition: 0 } },
          selector: { matchLabels: labels('cohort') },
          template: {
            metadata: { labels: labels('cohort') },
            spec: {
              serviceAccountName: c.vaultAgent.serviceAccount,
              automountServiceAccountToken: false,
              // Service links would inject API_PORT=tcp://... into every container and collide
              // with the roles' own <ROLE>_PORT settings.
              enableServiceLinks: false,
              securityContext: podSecurity,
              terminationGracePeriodSeconds: c.cohort.terminationGraceSeconds,
              initContainers: [
                installConfig(cohortRoles),
                // Native sidecar (restartPolicy Always): starts before the roles and the startup
                // probe holds them until the sink has a token (Compose: depends_on healthy).
                {
                  name: 'vault-agent',
                  image: c.images.vault,
                  restartPolicy: 'Always',
                  args: ['vault', 'agent', '-config=/vault/config/agent.hcl'],
                  env: [
                    { name: 'VAULT_ADDR', value: 'https://vault:8200' },
                    { name: 'VAULT_CACERT', value: '/run/ns-ca/ca.crt' },
                    { name: 'SKIP_SETCAP', value: '1' },
                  ],
                  startupProbe: { exec: { command: ['test', '-s', '/run/ns-vault/token'] }, periodSeconds: 2, failureThreshold: 45 },
                  securityContext: hardened,
                  volumeMounts: [
                    { name: 'vault-agent-config', mountPath: '/vault/config', readOnly: true },
                    { name: 'ns-vault', mountPath: '/run/ns-vault' },
                    { name: 'vault-token', mountPath: '/var/run/secrets/vault', readOnly: true },
                    caMount,
                    tmpMount,
                  ],
                },
              ],
              containers: [
                roleContainer('api', [{ name: 'http-api', containerPort: 1337 }]),
                roleContainer('realtime', [{ name: 'http-realtime', containerPort: 1339 }]),
                roleContainer('evaluator', [], [
                  { name: c.evaluatorPool.membersEnv, value: std.toString(c.evaluatorPool.members) },
                  { name: c.evaluatorPool.ordinalEnv, valueFrom: { fieldRef: { fieldPath: "metadata.labels['apps.kubernetes.io/pod-index']" } } },
                ]),
                // The owner plane (1341): a container port only; no Service, and the
                // NetworkPolicy admits nothing to it.
                roleContainer('tenant-admin', [{ name: 'int-owner', containerPort: 1341 }]),
              ],
              volumes: std.flattenArrays([configVolumes(r) for r in cohortRoles]) + [
                // serve.internal sockets: pod-private, never shared with another Pod.
                { name: 'ns-ipc', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
                { name: 'ns-vault', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
                {
                  name: 'vault-token',
                  projected: { defaultMode: 256, sources: [{ serviceAccountToken: { audience: c.vaultAgent.audience, expirationSeconds: 3600, path: 'token' } }] },
                },
                { name: 'vault-agent-config', configMap: { name: 'vault-agent-config' } },
                ca,
                tmp,
              ],
            },
          },
        },
      },
    },

    // ---------------------------------------------------------------- admin plane
    admin: {
      // Compose overlay: ADMIN_HOSTNAME=admin (its own private address), ADMIN_PORT=1342, the
      // non-loopback acknowledgement, no published port, no nginx route.
      deployment: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: meta('admin', 'admin'),
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: labels('admin') },
          template: {
            metadata: { labels: labels('admin') },
            spec: {
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              securityContext: podSecurity,
              initContainers: [installConfig(['admin'])],
              containers: [{
                name: 'admin',
                image: c.images.app,
                imagePullPolicy: 'IfNotPresent',
                // admin-entrypoint.js of the Compose overlay, inline: private environment
                // document, then core's CLI.
                command: ['node', '-e', "require('/opt/app/deploy/multitenant/load-env');require('/opt/app/lib/cli').main(['multitenant','admin'])"],
                env: [
                  { name: 'ADMIN_HOSTNAME', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } },
                  { name: 'ADMIN_PORT', value: '1342' },
                  { name: 'ADMIN_INSECURE_BIND_ACKNOWLEDGED', value: 'true' },
                  { name: 'MULTITENANT_ADMIN_CONFIG', value: '/run/ns-config/admin.json' },
                ],
                ports: [{ name: 'int-admin', containerPort: 1342 }],
                readinessProbe: { tcpSocket: { port: 'int-admin' }, periodSeconds: 2, timeoutSeconds: 3, failureThreshold: 30 },
                securityContext: hardened,
                volumeMounts: [configMount('admin'), tmpMount],
              }],
              volumes: configVolumes('admin') + [tmp],
            },
          },
        },
      },
      service: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('admin', 'admin'),
        spec: { type: 'ClusterIP', selector: labels('admin'), ports: [{ name: 'admin', port: 1342, targetPort: 'int-admin' }] },
      },
    },

    // ---------------------------------------------------------------- pages and edge
    ui: {
      deployment: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: meta('ui', 'ui'),
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: labels('ui') },
          template: {
            metadata: { labels: labels('ui') },
            spec: {
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              securityContext: podSecurity,
              initContainers: [installConfig(['ui'])],
              containers: [{
                name: 'ui',
                image: c.images.app,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', 'deploy/multitenant/ui.js'],
                env: [
                  { name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' },
                  { name: 'UI_HOSTNAME', value: '0.0.0.0' },
                  { name: 'UI_PORT', value: '1340' },
                  { name: 'UI_PUBLIC_CONFIG', value: '/run/ns-config/config.json' },
                ],
                ports: [{ name: 'http-ui', containerPort: 1340 }],
                readinessProbe: { exec: { command: ['node', 'deploy/multitenant/health.js', 'ui'] }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 },
                securityContext: hardened,
                volumeMounts: [configMount('ui'), tmpMount],
              }],
              volumes: configVolumes('ui') + [tmp],
            },
          },
        },
      },
      service: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('ui', 'ui'),
        spec: { selector: labels('ui'), ports: [{ name: 'http', port: 1340, targetPort: 'http-ui' }] },
      },
    },

    edge: {
      config: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: meta('edge-nginx', 'edge'),
        // The Compose tree's nginx.conf, byte for byte.
        data: { 'nginx.conf': importstr '../../../compose/multitenant/nginx.conf' },
      },
      deployment: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: meta('edge', 'edge'),
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: labels('edge') },
          template: {
            metadata: { labels: labels('edge') },
            spec: {
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              containers: [{
                name: 'nginx',
                image: c.images.nginx,
                ports: [{ name: 'http-edge', containerPort: 8080 }],
                readinessProbe: { tcpSocket: { port: 'http-edge' }, periodSeconds: 2 },
                volumeMounts: [{ name: 'nginx', mountPath: '/etc/nginx/nginx.conf', subPath: 'nginx.conf', readOnly: true }],
              }],
              volumes: [{ name: 'nginx', configMap: { name: 'edge-nginx' } }],
            },
          },
        },
      },
      // The consumer entry: the one Service meant to be reachable from outside the namespace.
      service: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('edge', 'edge') + { annotations: { 'nightscout.org/consumer-entry': 'true' } },
        spec: { type: c.edge.serviceType, selector: labels('edge'), ports: [{ name: 'http', port: c.edge.port, targetPort: 'http-edge' }] },
      },
    },

    // ---------------------------------------------------------------- provisioning
    provision: {
      state: {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: meta('provision-state', 'provision'),
        spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: c.storage.provisionState } } },
      },
      scripts: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: meta('provision-scripts', 'provision'),
        data: { 'vault-kubernetes-auth.js': importstr '../../ops/vault-kubernetes-auth.js' },
      },
      // Explicit provisioning, separate from serving startup. Steps run in order as init
      // containers; no retry (backoffLimit 0) so an uncertain result is never re-run silently.
      // Compose: bootstrap, vault-agent-bootstrap, ownership-grants (profile ops).
      job: {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: meta('provision', 'provision'),
        spec: {
          backoffLimit: 0,
          template: {
            metadata: { labels: labels('provision') },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              securityContext: podSecurity,
              local step(name, command, env) = {
                name: name,
                image: c.images.app,
                imagePullPolicy: 'IfNotPresent',
                command: command,
                env: [
                  { name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' },
                  { name: 'VAULT_ADDR', value: 'https://vault:8200' },
                  { name: 'NS_BOOTSTRAP_OUTPUT', value: '/state' },
                ] + env,
                securityContext: hardened,
                volumeMounts: [
                  { name: 'state', mountPath: '/state' },
                  { name: 'postgres-password', mountPath: '/run/secrets', readOnly: true },
                  caMount,
                  { name: 'scripts', mountPath: '/run/ns-overlay', readOnly: true },
                  { name: 'ownership-grants', mountPath: '/run/ns-overlay-ownership', readOnly: true },
                  tmpMount,
                ],
              },
              initContainers: [
                // Compose depends_on: postgres and vault healthy. TCP reachability here; the
                // bootstrap's own checks refuse an unready store.
                step('wait-stores', ['node', '-e', |||
                  const net=require('node:net');
                  const up=(host,port)=>new Promise(r=>{const s=net.connect({host,port});s.setTimeout(1500);s.once('connect',()=>{s.end();r(true)});s.once('timeout',()=>{s.destroy();r(false)});s.once('error',()=>r(false));});
                  (async()=>{for(let i=0;i<120;i++){if(await up('postgres',5432)&&await up('vault',8200))return;await new Promise(r=>setTimeout(r,2000));}process.exit(1);})();
                |||], []),
                step('bootstrap', ['node', 'deploy/multitenant/bootstrap.js'], [
                  { name: 'NS_COMPOSE_BOOTSTRAP', value: '1' },
                  { name: 'NS_POSTGRES_HOST', value: 'postgres' },
                  { name: 'NS_POSTGRES_DATABASE', value: 'nightscout_compose_test' },
                  { name: 'NS_POSTGRES_PASSWORD_FILE', value: '/run/secrets/postgres-password' },
                ]),
                step('vault-kubernetes-auth', ['node', '/run/ns-overlay/vault-kubernetes-auth.js', 'provision'], [
                  { name: 'NS_VAULT_K8S_AUTH', value: '1' },
                  { name: 'NS_VAULT_K8S_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                  { name: 'NS_VAULT_K8S_SERVICE_ACCOUNT', value: c.vaultAgent.serviceAccount },
                  { name: 'NS_VAULT_K8S_AUDIENCE', value: c.vaultAgent.audience },
                  { name: 'NS_VAULT_AGENT_TOKEN_TTL', value: c.vaultAgent.tokenTtl },
                  { name: 'NS_VAULT_AGENT_TOKEN_MAX_TTL', value: c.vaultAgent.tokenMaxTtl },
                ]),
                step('ownership-grants', ['node', '/run/ns-overlay-ownership/ownership-grants.js', 'provision'], [
                  { name: 'NS_OWNERSHIP_GRANTS', value: '1' },
                  { name: 'NS_POSTGRES_PASSWORD_FILE', value: '/run/secrets/postgres-password' },
                ]),
              ],
              containers: [
                step('done', ['node', '-e', "const fs=require('node:fs');for(const f of ['bootstrap/complete.json','vault-agent/complete.json','ownership-admin/complete.json'])if(!fs.existsSync('/state/'+f))process.exit(1);process.stdout.write(JSON.stringify({state:'provisioned'})+'\\n')"], []),
              ],
              volumes: [
                { name: 'state', persistentVolumeClaim: { claimName: 'provision-state' } },
                { name: 'postgres-password', secret: { secretName: 'ns-postgres-password', defaultMode: 288 } },
                ca,
                { name: 'scripts', configMap: { name: 'provision-scripts' } },
                // The Compose ownership overlay's script, from a ConfigMap made at apply time
                // (scripts/secrets.sh seed) out of ../compose/ownership-admin/ownership-grants.js.
                { name: 'ownership-grants', configMap: { name: 'ownership-grants' } },
                tmp,
              ],
            },
          },
        },
      },
    },

    // ---------------------------------------------------------------- network policy
    // Compose: one internal backend network plus a published edge. Here the namespace denies
    // ingress by default and admits each path the Compose topology uses. Enforcement depends on
    // the cluster's network plugin.
    networkPolicies: {
      local np(name, podSelector, from, ports) = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: meta(name, 'network'),
        spec: { podSelector: podSelector, policyTypes: ['Ingress'], ingress: [{ from: from, ports: ports }] },
      },
      local sel(component) = { podSelector: { matchLabels: { 'app.kubernetes.io/component': component } } },
      defaultDeny: {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: meta('default-deny-ingress', 'network'),
        spec: { podSelector: {}, policyTypes: ['Ingress'] },
      },
      edgeIn: np('edge-ingress', { matchLabels: labels('edge') }, [{ ipBlock: { cidr: '0.0.0.0/0' } }], [{ port: 8080, protocol: 'TCP' }]),
      cohortFromEdge: np('cohort-from-edge', { matchLabels: labels('cohort') }, [sel('edge')], [{ port: 1337, protocol: 'TCP' }, { port: 1339, protocol: 'TCP' }]),
      uiFromEdge: np('ui-from-edge', { matchLabels: labels('ui') }, [sel('edge')], [{ port: 1340, protocol: 'TCP' }]),
      adminFromOperator: np('admin-from-operator', { matchLabels: labels('admin') }, [sel('operator')], [{ port: 1342, protocol: 'TCP' }]),
      postgresFromApp: np('postgres-from-app', { matchLabels: labels('postgres') }, [sel('cohort'), sel('admin'), sel('provision'), sel('operator')], [{ port: 5432, protocol: 'TCP' }]),
      vaultFromApp: np('vault-from-app', { matchLabels: labels('vault') }, [sel('cohort'), sel('provision'), sel('vault')], [{ port: 8200, protocol: 'TCP' }]),
    },

    // ---------------------------------------------------------------- inventory (not applied)
    // Which PostgreSQL identity (<prefix>_<name>) each workload connects as, from the Compose
    // plan's per-role environment documents. check/invariants.js compares it with
    // ../compose/multitenant/config.js and the ownership overlay. Tanka ignores non-manifests.
    inventory:: {
      prefix: c.prefix,
      sourceCommit: c.sourceCommit,
      evaluatorPool: c.evaluatorPool,
      postgresIdentities: {
        api: ['alarm', 'api', 'lifetime_api', 'readiness', 'root_writer'],
        realtime: ['lifetime_realtime', 'realtime'],
        evaluator: ['evaluator', 'lifetime_evaluator', 'outbox', 'suppression'],
        'tenant-admin': ['lifetime_tenant_admin', 'owner_reader', 'owner_writer'],
        admin: ['ownership_operator'],
      },
    },
  },
}
