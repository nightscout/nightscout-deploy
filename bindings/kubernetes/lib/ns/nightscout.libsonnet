// Kubernetes binding of the multitenant Compose tree (../../compose/multitenant).
//
// Same image, same commands, same scoped credentials, same in-container paths. What
// changes is only the binding: Compose services become ordinary Kubernetes resources.
//
//   api, tenant-admin (Deployments) one replica each, Recreate; the api Pod carries the Vault
//                                  Agent as a native sidecar (Kubernetes auth)
//   evaluator, realtime (StatefulSets) slice = Pod ordinal, K from `slices`
//                                  (components.libsonnet); evaluator K>1 uses the Compose roster
//   admin (Deployment)             the ownership-operations plane on its own Pod address and port;
//                                  ClusterIP only, NetworkPolicy admits operator Pods only
//   ui, edge (Deployments)         the shipped pages and the reference nginx (consumer entry)
//   postgres, vault (StatefulSets) the backing stores, same image digests as Compose
//   provision (Job)                PostgreSQL roles and schemas, Vault tokens, Vault Kubernetes auth
//   primer (Job)                   optional synthetic tenant provisioning through admin
//
// No credential is rendered. Secrets flow in, never out (decision provisioning-secrets-in):
// scripts/secrets.sh seeds every credential and renders every role document before apply, the
// provision Job only reads its mounted credentials, and one apply converges. This file only names
// the Secrets.
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
      postgres: null,  // required: supplied maintained PostgreSQL/wal2json image digest
      vault: 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2',
      nginx: 'nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10',
    },
    // Decision statefulset-ordinal-scaling: K per sliced role. The same value sets the
    // StatefulSet replicas and the slice count. Evaluator K>1: hostname ordinal, NS_EVALUATOR_SLICES,
    // DNS receivers evaluator-<i>.evaluator, patched pgstream slice_receivers on one slot (components.libsonnet).
    slices: { realtime: 1, evaluator: 1 },
    // Above the serve.internal drain deadline (NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS, default
    // 5000 ms, at most 60000 ms; decision internal-listener-graceful-shutdown).
    terminationGraceSeconds: 30,
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
    imageDeployCommit: null,  // supplied with the selected application image
    bindingIdentity: 'UNSET',
    runId: 'synthetic-preview',
    profile: 'standard',
    resourceAccounting: 'requests-v1',
    tenantCount: 2,
    provisionDeadlineSeconds: 900,
    imagePullSecrets: [],
    placement: {},
    placementByWorkload: {},
    // Extra environment rows per application role (api, evaluator, realtime, tenant-admin),
    // appended after the binding's own rows: diagnostics and profiling switches only.
    roleEnv: {},
    // Opt-in lab metrics (lab-metrics.libsonnet): per-namespace Prometheus, postgres_exporter
    // sidecar and NS_METRICS=true on the roles. Off by default; off renders nothing extra.
    labMetrics: (import 'lab-metrics.libsonnet').defaults,
    resources: {
      [name]: {
        requests: { cpu: '25m', memory: '32Mi', 'ephemeral-storage': '16Mi' },
        limits: { cpu: '500m', memory: '256Mi', 'ephemeral-storage': '128Mi' },
      }
      for name in ['install-config', 'vault-agent', 'wait-stores', 'bootstrap', 'vault-kubernetes-auth', 'primer', 'api', 'realtime', 'evaluator', 'tenant-admin', 'admin', 'ui', 'pgstream', 'postgres', 'nginx', 'vault', 'prometheus', 'postgres-exporter']
    },
    storage: { mode: 'dynamic', postgres: '1Gi', vault: '256Mi', provisionState: '64Mi', primerResults: '64Mi', claims: {} },
  },

  raw(overrides):: {
    local c = std.mergePatch($.defaults, overrides),
    local ns = c.namespace,
    assert std.isString(c.sourceCommit) && std.length(c.sourceCommit) == 40 && std.length([x for x in std.stringChars(c.sourceCommit) if !std.member(std.stringChars('0123456789abcdef'),x)]) == 0 : 'sourceCommit must be the full 40-hex commit',
    assert std.isString(c.images.app) && std.length(std.split(c.images.app, '@')) == 2 && std.startsWith(std.split(c.images.app, '@')[1], 'sha256:') && std.length(std.split(c.images.app, '@')[1]) == 71 : 'images.app requires an immutable manifest digest',
    assert std.isString(c.images.postgres) && std.length(std.split(c.images.postgres, '@')) == 2 && std.startsWith(std.split(c.images.postgres, '@')[1], 'sha256:') && std.length(std.split(c.images.postgres, '@')[1]) == 71 : 'images.postgres requires an explicit maintained PostgreSQL/wal2json image digest',
    assert c.prefix == 'nsdemo' : 'source bootstrap supports only prefix nsdemo',

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
    // OnRootMismatch: a remounted or snapshot-restored claim keeps its 0600 private files;
    // the default (Always) re-applies group bits on every mount and they are then refused.
    local podSecurity = { fsGroup: uid, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
    // Compose tmpfs /tmp.
    local tmp = { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
    local tmpMount = { name: 'tmp', mountPath: '/tmp' },
    // The public demo CA (Compose ${NS_DEMO_STATE}/tls/ca.crt), from a Secret made at apply time.
    local ca = { name: 'ns-ca', secret: { secretName: 'ns-ca', defaultMode: 292 } },
    local caMount = { name: 'ns-ca', mountPath: '/run/ns-ca', readOnly: true },

    // Serving roles mount Secrets directly. Only the standalone UI preloader
    // needs its JSON files copied into a private memory-backed directory.
    local configVolumes(role) = [
      { name: 'secret-' + role, secret: { secretName: 'ns-config-' + role, defaultMode: 288 } },
      { name: 'config-' + role, emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
    ],
    // The standalone UI reads a strict private env.json. The primer only
    // reads its public origin settings and mounts its Secret directly.
    local installUi = {
      name: 'install-config', image: c.images.app, imagePullPolicy: 'IfNotPresent',
      command: ['node', '-e', |||
        const fs=require('node:fs'),dir='/run/ns-config/ui/d';
        fs.mkdirSync(dir,{recursive:true,mode:0o700});
        for(const file of ['config.json','env.json']){
          fs.writeFileSync(dir+'/'+file,fs.readFileSync('/run/ns-secret/ui/'+file),{mode:0o400});
        }
      |||],
      securityContext: hardened,
      volumeMounts: [{ name: 'secret-ui', mountPath: '/run/ns-secret/ui', readOnly: true }, { name: 'config-ui', mountPath: '/run/ns-config/ui' }],
    },
    local secretMount(role) = { name: 'secret-' + role, mountPath: '/run/ns-config', readOnly: true },
    local configMount(role) = { name: 'config-' + role, mountPath: '/run/ns-config', subPath: 'd', readOnly: true },

    local roleContainer(role, ports, extraEnv=[]) = {
      name: role,
      image: c.images.app,
      imagePullPolicy: 'IfNotPresent',
      command: ['node', 'deploy/multitenant/entrypoint.js', role],
      env: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' }] + extraEnv,
      ports: ports,
      // Probes: components.libsonnet (httpGet on the role's private listener, /healthz/*).
      securityContext: hardened,
      volumeMounts: [
        secretMount(role),
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

    local roleNames = ['api', 'realtime', 'evaluator', 'tenant-admin'],

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
                // Preserve docker-entrypoint.sh: it owns initdb before postgres starts.
                args: ['postgres', '-c', 'wal_level=logical', '-c', 'max_replication_slots=4', '-c', 'max_wal_senders=' + std.max(4, c.slices.evaluator + 2), '-c', 'max_slot_wal_keep_size=-1', '-c', 'output_plugin_libraries=wal2json', '-c', 'max_connections=140', '-c', 'reserved_connections=40',
                  // Statement statistics and I/O timing for capacity runs (the observer snapshots
                  // pg_stat_statements around steady state); the image ships the contrib module.
                  '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'track_io_timing=on'],
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
      // Bootstrap reaches the sealed (not ready) Vault here. A ClusterIP name resolves from the
      // moment the Service exists. A headless name resolves only once the Pod address is
      // published, and for a few seconds the CoreDNS replicas can disagree: bootstrap retries only
      // its first Vault call, so a later NXDOMAIN left Vault sealed (fixture-restore fault 1).
      bootstrapService: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('vault-bootstrap', 'vault'),
        spec: { publishNotReadyAddresses: true, selector: labels('vault'), ports: [{ name: 'vault', port: 8200, targetPort: 'vault' }] },
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
              // The image runs as its vault user (uid 100, gid 1000) and chowns nothing, so a
              // block volume (fixture or existing claim) is writable only through its group.
              securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
              containers: [{
                name: 'vault',
                image: c.images.vault,
                args: ['vault', 'server', '-config=/vault/config/demo.hcl'],
                ports: [{ name: 'vault', containerPort: 8200 }],
                readinessProbe: {
                  httpGet: { scheme: 'HTTPS', port: 'vault', path: '/v1/sys/health?uninitcode=200' },
                  periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 1,
                },
                volumeMounts: [
                  { name: 'data', mountPath: '/vault/file' },
                  { name: 'logs', mountPath: '/vault/logs' },
                  { name: 'tls', mountPath: '/run/ns-tls', readOnly: true },
                  caMount,
                  { name: 'config', mountPath: '/vault/config', readOnly: true },
                ],
              }],
              volumes: [
                { name: 'logs', emptyDir: { sizeLimit: '16Mi' } },
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

    // ---------------------------------------------------------------- role Pod template
    // The shared source of every role workload; components.libsonnet renders one workload per
    // role from it. Not rendered itself.
    roleTemplate:: {
      serviceAccount: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(c.vaultAgent.serviceAccount, 'api'), automountServiceAccountToken: false },
      agentConfig: { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('vault-agent-config', 'api'), data: { 'agent.hcl': agentHcl } },
      spec: {
      serviceAccountName: c.vaultAgent.serviceAccount,
      automountServiceAccountToken: false,
      // Service links would inject API_PORT=tcp://... into every container and collide
      // with the roles' own <ROLE>_PORT settings.
      enableServiceLinks: false,
      securityContext: podSecurity,
      terminationGracePeriodSeconds: c.terminationGraceSeconds,
      initContainers: [
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
        roleContainer('evaluator', [{ name: 'stream-intake', containerPort: 19913 }]),
        // The owner plane (1341): a container port only; no Service, and the
        // NetworkPolicy admits nothing to it.
        roleContainer('tenant-admin', [{ name: 'int-owner', containerPort: 1341 }]),
      ],
      volumes: [configVolumes(r)[0] for r in roleNames] + [
        // serve.internal sockets: pod-private, never shared with another Pod.
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

    // One independently managed consumer of the precreated database slot.
    pgstream: {
      deployment: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: meta('pgstream', 'pgstream'),
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: labels('pgstream') },
          template: {
            metadata: { labels: labels('pgstream') },
            spec: {
              enableServiceLinks: false,
              automountServiceAccountToken: false,
              securityContext: podSecurity,
              terminationGracePeriodSeconds: c.terminationGraceSeconds,
              containers: [{
                name: 'pgstream', image: c.images.app, imagePullPolicy: 'IfNotPresent',
                command: ['/usr/local/bin/pgstream', 'run', '-c', '/run/ns-stream/pgstream.yaml', '--log-level', 'info'],
                securityContext: hardened,
                volumeMounts: [{ name: 'secret-pgstream', mountPath: '/run/ns-stream', readOnly: true }, tmpMount],
              }],
              volumes: [{ name: 'secret-pgstream', secret: { secretName: 'ns-config-pgstream', defaultMode: 288 } }, tmp],
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
              initContainers: [],
              containers: [{
                name: 'admin',
                image: c.images.app,
                imagePullPolicy: 'IfNotPresent',
                // Source-owned registry admin, with only the private bind address adapted.
                command: ['node', 'deploy/multitenant/entrypoint.js', 'admin'],

                ports: [{ name: 'int-admin', containerPort: 1342 }],
                env: [
                  { name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' },
                  { name: 'NS_VAULT_ADDR', value: 'https://vault:8200' },
                  { name: 'ADMIN_HOSTNAME', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } },
                  { name: 'ADMIN_PORT', value: '1342' }, { name: 'ADMIN_INSECURE_BIND_ACKNOWLEDGED', value: 'true' },
                ],
                readinessProbe: { httpGet: { path: '/v1/openapi.json', port: 'int-admin' }, periodSeconds: 2, timeoutSeconds: 3, failureThreshold: 30 },
                securityContext: hardened,
                volumeMounts: [secretMount('admin'), caMount, tmpMount],
              }],
              volumes: [configVolumes('admin')[0], ca, tmp],
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
              initContainers: [installUi],
              containers: [{
                name: 'ui',
                image: c.images.app,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', '-r', './deploy/multitenant/load-env.js', 'deploy/multitenant/ui.js'],
                env: [
                  { name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' },
                  { name: 'UI_HOSTNAME', value: '0.0.0.0' },
                  { name: 'UI_PORT', value: '1340' },
                  { name: 'UI_PUBLIC_CONFIG', value: '/run/ns-config/config.json' },
                ],
                ports: [{ name: 'http-ui', containerPort: 1340 }],
                readinessProbe: { httpGet: { path: '/healthz', port: 'http-ui' }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 },
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
        // Default source bytes stay exact; selected edge settings change only two directives.
        data: { 'nginx.conf': (import 'edge-configuration.libsonnet').render(importstr '../../assets/nginx.conf', c.edge) },
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
        data: {
          'vault-kubernetes-auth.js': importstr '../../ops/vault-kubernetes-auth.js',
        },
      },
      // Explicit provisioning, separate from serving startup: wait for PostgreSQL, create the roles,
      // schemas and Vault tokens from the seeded credentials, then configure Vault Kubernetes auth.
      // No retry (backoffLimit 0) so an uncertain result is never re-run silently. The Job writes no
      // role document and holds nothing for export; it completes when Kubernetes auth is configured.
      job: {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: meta('provision', 'provision'),
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: c.provisionDeadlineSeconds,
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
                  { name: 'VAULT_ADDR', value: if name == 'vault-kubernetes-auth' then 'https://vault-bootstrap:8200' else 'https://vault:8200' },
                  { name: 'NS_BOOTSTRAP_OUTPUT', value: '/state' },
                  { name: 'NS_SOURCE_COMMIT', value: c.sourceCommit },
                  { name: 'NS_DEPLOY_COMMIT', value: if c.imageDeployCommit == null then c.sourceCommit else c.imageDeployCommit },
                ] + env,
                securityContext: hardened,
                volumeMounts: [
                  { name: 'state', mountPath: '/state' },
                  caMount,
                  { name: 'scripts', mountPath: '/run/ns-overlay', readOnly: true },
                  tmpMount,
                ] + (if name == 'bootstrap' then [
                  { name: 'postgres-password', mountPath: '/run/secrets', readOnly: true },
                  { name: 'credentials-postgres', mountPath: '/run/ns-credentials/postgres', readOnly: true },
                  { name: 'credentials-vault', mountPath: '/run/ns-credentials/vault', readOnly: true },
                ] else []),
              },
              initContainers: [
                // Bootstrap checks the Vault API itself, including when the store is sealed, but
                // retries only its first call: wait until both stores accept connections, so a
                // Vault Pod that starts after bootstrap (late volume attach) is not a terminal error.
                step('wait-stores', ['node', '-e', |||
                  const net=require('node:net');
                  const up=(host,port)=>new Promise(r=>{const s=net.connect({host,port});s.setTimeout(1500);s.once('connect',()=>{s.end();r(true)});s.once('timeout',()=>{s.destroy();r(false)});s.once('error',()=>r(false));});
                  (async()=>{for(let i=0;i<120;i++){if(await up('postgres',5432)&&await up('vault-bootstrap',8200))return;await new Promise(r=>setTimeout(r,2000));}process.exit(1);})();
                |||], []),
                step('bootstrap', ['node', 'deploy/multitenant/bootstrap.js'], [
                  { name: 'NS_COMPOSE_BOOTSTRAP', value: '1' },
                  { name: 'NS_BOOTSTRAP_VAULT_ADDR', value: 'https://vault-bootstrap:8200' },
                  { name: 'NS_PGSTREAM', value: '1' },
                ] + (if c.slices.evaluator > 1 then [
                  // The DNS receiver roster: one subscriptions row set per receiver (pgstream.js init).
                  { name: 'NS_EVALUATOR_WORKERS', value: std.toString(c.slices.evaluator) },
                ] else []) + [
                  { name: 'NS_API_REPLICAS', value: '1' },
                  { name: 'NS_POSTGRES_HOST', value: 'postgres' },
                  { name: 'NS_POSTGRES_DATABASE', value: 'nightscout_compose_test' },
                  { name: 'NS_POSTGRES_PASSWORD_FILE', value: '/run/secrets/postgres-password' },
                  { name: 'NS_CREDENTIALS_DIR', value: '/run/ns-credentials' },
                ]),
              ],
              containers: [
                step('vault-kubernetes-auth', ['node', '/run/ns-overlay/vault-kubernetes-auth.js', 'provision'], [
                  { name: 'NS_VAULT_K8S_AUTH', value: '1' },
                  { name: 'NS_VAULT_K8S_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                  { name: 'NS_VAULT_K8S_SERVICE_ACCOUNT', value: c.vaultAgent.serviceAccount },
                  { name: 'NS_VAULT_K8S_AUDIENCE', value: c.vaultAgent.audience },
                  { name: 'NS_VAULT_AGENT_TOKEN_TTL', value: c.vaultAgent.tokenTtl },
                  { name: 'NS_VAULT_AGENT_TOKEN_MAX_TTL', value: c.vaultAgent.tokenMaxTtl },
                ]),
              ],
              volumes: [
                { name: 'state', persistentVolumeClaim: { claimName: 'provision-state' } },
                { name: 'postgres-password', secret: { secretName: 'ns-postgres-password', defaultMode: 288 } },
                // Seeded before apply; only this Job mounts them.
                { name: 'credentials-postgres', secret: { secretName: 'ns-credentials-postgres', defaultMode: 288 } },
                { name: 'credentials-vault', secret: { secretName: 'ns-credentials-vault', defaultMode: 288 } },
                ca,
                { name: 'scripts', configMap: { name: 'provision-scripts' } },
                tmp,
              ],
            },
          },
        },
      },
    },

    // The lab client writes its private results to its own claim, where an in-cluster consumer
    // mounts them; nothing waits for an export.
    local clientJob(jobName, command, extra={}) = {
      job: {
        apiVersion: 'batch/v1', kind: 'Job', metadata: meta(jobName, 'operator'),
        spec: { suspend: true, backoffLimit: 0, activeDeadlineSeconds: c.provisionDeadlineSeconds,
          template: { metadata: { labels: labels('operator') }, spec: {
            restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
            securityContext: podSecurity,

            containers: [{
              name: jobName, image: c.images.app, imagePullPolicy: 'IfNotPresent', securityContext: hardened,
              command: command,
              volumeMounts: [{ name: 'secret-primer', mountPath: '/run/ns-primer', readOnly: true }, tmpMount] + std.get(extra, 'mounts', []),
            } + std.get(extra, 'container', {})],
            volumes: [configVolumes('primer')[0]] + [tmp] + std.get(extra, 'volumes', []),
          } },
        },
      },
    } + std.get(extra, 'objects', {}),
    primer: clientJob('primer', ['sh', '-euc', 'node deploy/multitenant/prime.js provision --tenant-count "$NS_DEMO_TENANTS" && exec node deploy/multitenant/prime.js prime --concurrency "$NS_PRIMER_CONCURRENCY"'], {
      container: {
        env: [{ name: 'NS_DEMO_TENANTS', value: std.toString(c.tenantCount) },
              { name: 'NS_PRIMER_CONCURRENCY', value: std.toString(std.get(c, 'primerConcurrency', 1)) },
              { name: 'NS_PRIMER_STATE', value: '/run/ns-client' }, { name: 'NS_PRIMER_CONFIG', value: '/run/ns-primer/config.json' }],
      },
      mounts: [{ name: 'client-state', mountPath: '/run/ns-client' }],
      volumes: [{ name: 'client-state', persistentVolumeClaim: { claimName: 'primer-results' } }],
      objects: {
        results: {
          apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta('primer-results', 'operator'),
          spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: c.storage.primerResults } } },
        },
      },
    }),
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
      uiFromEdge: np('ui-from-edge', { matchLabels: labels('ui') }, [sel('edge')], [{ port: 1340, protocol: 'TCP' }]),
      adminFromOperator: np('admin-from-operator', { matchLabels: labels('admin') }, [sel('operator')], [{ port: 1342, protocol: 'TCP' }]),
      // postgresFromApp and vaultFromApp: per role, in components.libsonnet.
    },

    // ---------------------------------------------------------------- inventory (not applied)
    // Rendering facts check/invariants.js reads. Tanka ignores non-manifests.
    inventory:: {
      prefix: c.prefix,
      sourceCommit: c.sourceCommit,
      slices: c.slices,
    },
  },

  // Platform binding only: no role document construction or application lifecycle logic here.
  new(overrides)::
    local c = std.mergePatch($.defaults, overrides);
    local original = $.raw(overrides);
    local typical = import 'typical-requests.json';
    assert std.member(['limits-v1', 'requests-v1'], c.resourceAccounting) : 'unknown resource accounting';
    local raw = (import 'components.libsonnet').render(original, c);
    local collect(v) = if std.isArray(v) then std.flattenArrays([collect(x) for x in v]) else if !std.isObject(v) then [] else if std.objectHas(v, 'apiVersion') && std.objectHas(v, 'kind') then [v] else std.flattenArrays([collect(v[k]) for k in std.objectFields(v)]);
    assert std.member(['standard', 'existing-capacity'], c.profile) : 'unknown profile';
    assert std.member(['dynamic', 'disposable', 'existing-claim'], c.storage.mode) : 'unknown storage mode';
    assert c.profile != 'existing-capacity' || (c.storage.mode != 'dynamic' && c.edge.serviceType == 'ClusterIP') : 'existing-capacity forbids dynamic storage and public Services';
    assert std.isNumber(c.tenantCount) && c.tenantCount == std.floor(c.tenantCount) && c.tenantCount >= 1 && c.tenantCount <= 9007199254740991 : 'tenantCount must be positive';
    local ownership = { 'nightscout.org/run-id': c.runId };
    local identity = {
      'nightscout.org/source-commit': c.sourceCommit,
      'nightscout.org/image-deploy-commit': if c.imageDeployCommit == null then c.sourceCommit else c.imageDeployCommit,
      'nightscout.org/binding-identity': c.bindingIdentity,
      'nightscout.org/app-image': c.images.app,
    };
    local stateVolume(key, name) =
      if c.storage.mode == 'disposable' then { name: name, emptyDir: { sizeLimit: c.storage[key] } }
      else { name: name, persistentVolumeClaim: { claimName: c.storage.claims[key] } };
    local decorate(v) =
      if std.isArray(v) then [decorate(x) for x in v]
      else if !std.isObject(v) then v
      else if std.objectHas(v, 'apiVersion') && std.objectHas(v, 'kind') then
        local base = if v.kind == 'StatefulSet' && c.storage.mode != 'dynamic' then v + { spec: { [k]: v.spec[k] for k in std.objectFields(v.spec) if k != 'volumeClaimTemplates' } } else v;
        base + { metadata+: { labels+: ownership, annotations+: identity } } +
        (if std.member(['Deployment', 'StatefulSet', 'Job'], v.kind) then
          local name = v.metadata.name;
          local spec = v.spec.template.spec;
          local resources(name) =
            local selected = c.resources[name];
            local authored = std.objectHas(overrides, 'resources') && std.objectHas(overrides.resources, name) && std.objectHas(overrides.resources[name], 'limits');
            if c.resourceAccounting == 'requests-v1' then
              { requests: std.mergePatch(typical[name],
                    if std.objectHas(overrides, 'resources') && std.objectHas(overrides.resources, name)
                    then std.get(overrides.resources[name], 'requests', {}) else {}) } +
              (if authored && overrides.resources[name].limits != null then { limits: overrides.resources[name].limits } else {})
            else selected;
          local containers(key) = [x + { resources: resources(x.name) } for x in spec[key]];
          local placement = c.placement + (if std.objectHas(c.placementByWorkload, name) then c.placementByWorkload[name] else {});
          { spec+: {
            template+: { metadata+: { labels+: ownership, annotations+: identity }, spec+: placement + {
              imagePullSecrets: c.imagePullSecrets,
              containers: containers('containers'),
              [if std.objectHas(spec,'initContainers') then 'initContainers']: containers('initContainers'),
              // Without dynamic storage the lab client keeps its results on a named claim when one is
              // given, else on the Pod's disk-backed emptyDir.
              volumes: [if name == 'provision' && x.name == 'state' && c.storage.mode != 'dynamic' then stateVolume('provisionState','state')
                        else if name == 'primer' && x.name == 'client-state' && c.storage.mode != 'dynamic' then
                          (if std.objectHas(c.storage.claims, 'primerResults') then { name: x.name, persistentVolumeClaim: { claimName: c.storage.claims.primerResults } } else { name: x.name, emptyDir: {} })
                        else x for x in spec.volumes] +
                (if c.storage.mode != 'dynamic' && std.member(['postgres','vault'],name) then [stateVolume(name,'data')] else []),
            } },
          } }
        else {})
      else { [k]: decorate(v[k]) for k in std.objectFields(v) if !(std.member(['state', 'results'], k) && std.objectHas(v,'job') && c.storage.mode != 'dynamic') };
    local resources = decorate(raw);
    local workloads = [w for w in collect(resources) if std.member(['Deployment','StatefulSet','Job'], w.kind)];
    local rendered = resources + { budget: (import 'namespace-budget.libsonnet')(workloads, c.namespace, c.runId) };
    rendered + {
      inventory:: original.inventory + {
        schemaVersion: 1,
        namespace: c.namespace,
        runId: c.runId,
        bindingIdentity: c.bindingIdentity,
        imageDeployCommit: if c.imageDeployCommit == null then c.sourceCommit else c.imageDeployCommit,
        images: c.images,
        [if (import 'lab-metrics.libsonnet').enabled(c) then 'labMetrics']: { enabled: true, images: (import 'lab-metrics.libsonnet').settings(c).images },
        profile: c.profile,
        [if (import 'edge-configuration.libsonnet').selected(c.edge) then 'edgeConfiguration']: (import 'edge-configuration.libsonnet').record(c.edge),
        resourceAccounting: c.resourceAccounting,
        storage: c.storage,
        qualification: { application: 'INHERITED_SEPARATELY', cluster: 'UNMEASURED', capacity: 'UNMEASURED', persistence: 'UNMEASURED' },
        documents: {
          api: ['ns_api_pg','ns_readiness_pg','ns_api_root_writer_pg','ns_alarm_pg','ns_display_pg','ns_lifetime_pg'],
          realtime: ['ns_realtime_pg','ns_display_pg','ns_lifetime_pg'],
          evaluator: ['ns_evaluator_pg','ns_outbox_pg','ns_suppression_pg','ns_activity_pg','ns_display_pg','ns_stream_recovery_pg','ns_lifetime_pg','ns_pgstream_generation'],
          'tenant-admin': ['ns_owner_writer_pg','ns_owner_reader_pg','ns_owner_credentials_pg','ns_owner_settings_pg','ns_lifetime_pg','vault-token'],
          admin: ['ns_provisioner_pg','ns_ownership_pg','ns_connector_sources_pg','ns_management_sessions_pg','vault-token','management-vault-token'],
          ui: ['env.json','config.json'], pgstream: ['pgstream.yaml'], primer: ['config.json'],
        },
        ownership: { namespace: c.namespace, label: { 'nightscout.org/run-id': c.runId }, clusterScoped: [{ kind: 'ClusterRoleBinding', name: c.namespace + '-vault-tokenreview' }] },
        services: { [v.metadata.name]: { selector: v.spec.selector, type: if std.objectHas(v.spec,'type') then v.spec.type else 'ClusterIP', ports: if std.objectHas(v.spec,'ports') then v.spec.ports else [] } for v in [v for v in collect(rendered) if v.kind == 'Service'] },
        configMaps: ['vault-config','vault-agent-config','edge-nginx','provision-scripts'],
        imagePullSecrets: c.imagePullSecrets,
        placement: c.placement,
        placementByWorkload: c.placementByWorkload,
        seed: { script: 'scripts/secrets.sh seed', [if c.slices.evaluator > 1 then 'environment']: { NS_EVALUATOR_WORKERS: std.toString(c.slices.evaluator) }, credentials: ['ns-credentials-postgres', 'ns-credentials-vault'], mountedBy: ['provision'] },
        results: { primer: { claim: if c.storage.mode == 'existing-claim' then std.get(c.storage.claims, 'primerResults', null) else if c.storage.mode == 'dynamic' then 'primer-results' else null, file: 'tenants.json' } },
        order: ['seed role Secrets', 'apply', 'run optional lab client; its private results stay on its claim', 'observe correctness', 'delete only owned namespace and tokenreview binding'],
        workloads: {
          [v.metadata.name]: {
            kind: v.kind, replicas: if v.kind == 'Job' then 1 else v.spec.replicas,
            component: v.spec.template.metadata.labels['app.kubernetes.io/component'],
            containers: [{ name: x.name, image: x.image, resources: x.resources, command: if std.objectHas(x,'command') then x.command else if std.objectHas(x,'args') then x.args else [],
              init: !std.member([z.name for z in v.spec.template.spec.containers],x.name) } for x in
                v.spec.template.spec.containers + (if std.objectHas(v.spec.template.spec,'initContainers') then v.spec.template.spec.initContainers else [])],
            secrets: [x.secret.secretName for x in v.spec.template.spec.volumes if std.objectHas(x,'secret')],
          }
          for v in [v for v in collect(rendered) if std.member(['Deployment', 'StatefulSet', 'Job'], v.kind)]
        },
      },
    },
}
