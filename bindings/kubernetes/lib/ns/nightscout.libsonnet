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
//   provision (Job)                source bootstrap -> Vault Kubernetes auth -> document proof
//   primer (Job)                   private admin tenant provision and platform verification
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
      postgres: null,  // required: supplied maintained PostgreSQL/wal2json image digest
      vault: 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2',
      nginx: 'nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10',
    },
    cohort: {
      // Decision cohort-pod-not-scaled: the one-Pod cohort is a monolith and scales vertically
      // only (resources), never horizontally; this binding (not core) holds it to one replica.
      // Core does not refuse a second cohort (kind smoke, 2026-11-10). For horizontal scale or
      // high availability, deploy the roles as separate components (per-role placement).
      replicas: 1,
      // Above the serve.internal drain deadline (NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS, default
      // 5000 ms, at most 60000 ms; decision internal-listener-graceful-shutdown).
      terminationGraceSeconds: 30,
    },
    // decisions evaluator-static-partition and pool-primitive-shared, core MT-POOL-PRIMITIVE
    // (lib/pool-membership/config.js): MULTITENANT_POOL_EVALUATOR_{PARTITION,MEMBERS,ORDINAL,
    // LEASE_MS,DATABASE_URL,NAMESPACE}. The StatefulSet pod-index is the ordinal. The desired
    // member count lives in the pool table, set by an operator command (maintainer, 2026-11-10),
    // so no MEMBERS variable is rendered. With the partition off core refuses any partitioned key
    // ("partition is off but ... set"), so off renders no pool variable at all. Readiness never
    // depends on pool eligibility: an OrderedReady StatefulSet would otherwise wait forever.
    evaluatorPool: {
      partition: 'off',
      partitionEnv: 'MULTITENANT_POOL_EVALUATOR_PARTITION',
      ordinalEnv: 'MULTITENANT_POOL_EVALUATOR_ORDINAL',
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
    imageDeployCommit: (import '../../assets/source-contract.json').deployCommit, // app bytes, not binding commit
    bindingIdentity: 'UNSET',
    runId: 'synthetic-preview',
    profile: 'standard',
    applicationTopology: 'cohort',
    resourceAccounting: 'limits-v1',
    tenantCount: 2,
    provisionDeadlineSeconds: 900,
    imagePullSecrets: [],
    placement: {},
    placementByWorkload: {},
    resources: {
      [name]: {
        requests: { cpu: '25m', memory: '32Mi', 'ephemeral-storage': '16Mi' },
        limits: { cpu: '500m', memory: '256Mi', 'ephemeral-storage': '128Mi' },
      }
      for name in ['install-config', 'vault-agent', 'wait-stores', 'bootstrap', 'vault-kubernetes-auth', 'done', 'primer', 'api', 'realtime', 'evaluator', 'tenant-admin', 'admin', 'ui', 'pgstream', 'postgres', 'nginx', 'vault']
    },
    storage: { mode: 'dynamic', postgres: '1Gi', vault: '256Mi', provisionState: '64Mi', claims: {} },
  },

  raw(overrides):: {
    local c = std.mergePatch($.defaults, overrides),
    local ns = c.namespace,
    local source = import '../../assets/source-contract.json',
    local helper = if std.objectHas(source, 'runtimeBootstrapHelper') then source.runtimeBootstrapHelper else null,
    local helperAnnotations = if helper == null then {} else {
      'nightscout.org/bootstrap-helper-commit': helper.deployCommit,
      'nightscout.org/bootstrap-helper-sha256': helper.sha256,
      'nightscout.org/instance-acceptance': 'PENDING',
    },
    local verifiedRoles = ['api', 'evaluator', 'realtime'],
    local adminFiles = ['env.json', 'config.json', 'vault-token', 'management-vault-token'],
    local targetNames = [role + '.' + kind + '.json' for role in verifiedRoles for kind in ['config', 'env', 'operation']],
    local docRefs(role) = if role == 'admin' then {
      items: [{ key: name, path: name } for name in adminFiles] +
             [{ key: 'verification-' + name, path: 'verification/' + name } for name in targetNames],
    } else {},
    assert std.isString(c.sourceCommit) && std.length(c.sourceCommit) == 40 && std.length([x for x in std.stringChars(c.sourceCommit) if !std.member(std.stringChars('0123456789abcdef'),x)]) == 0 : 'sourceCommit must be the full 40-hex commit',
    assert std.isString(c.images.app) && std.length(std.split(c.images.app, '@')) == 2 && std.startsWith(std.split(c.images.app, '@')[1], 'sha256:') && std.length(std.split(c.images.app, '@')[1]) == 71 : 'images.app requires an immutable manifest digest',
    assert std.isString(c.images.postgres) && std.length(std.split(c.images.postgres, '@')) == 2 && std.startsWith(std.split(c.images.postgres, '@')[1], 'sha256:') && std.length(std.split(c.images.postgres, '@')[1]) == 71 : 'images.postgres requires an explicit maintained PostgreSQL/wal2json image digest',
    assert c.prefix == 'nsdemo' : 'source bootstrap supports only prefix nsdemo',
    assert c.cohort.replicas == 1 : 'the preview renders exactly one cohort Pod',
    assert c.evaluatorPool.partition == 'off' : 'C3 requires the native K=1 evaluator without pool placement',

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
      { name: 'secret-' + role, secret: { secretName: 'ns-config-' + role, defaultMode: 288 } + docRefs(role) },
      { name: 'config-' + role, emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
    ],
    // An emptyDir root is root-owned 3777 under fsGroup (measured 2026-11-10). Core refuses
    // such a directory for the socket directory (lib/server/internal-api/transport.js: owner must
    // be the process uid, no group or other bits), as Compose's prepare.js 0700 directories
    // satisfy. So the init step creates a 0700 subdirectory `d` owned by uid 1000 in each volume
    // and the role containers mount that subdirectory (subPath), never the volume root.
    local installConfig(roles, ipc=false) = {
      name: 'install-config',
      image: c.images.app,
      imagePullPolicy: 'IfNotPresent',
      env: [{ name: 'NS_BIND_ADMIN_ADDRESS', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } }],
      command: ['node', '-e', |||
        const fs=require('node:fs');process.umask(0o077);
        if(fs.existsSync('/run/ns-ipc-volume'))fs.mkdirSync('/run/ns-ipc-volume/d',{recursive:true,mode:0o700});
        for(const role of process.argv.slice(1)){
          const dir='/run/ns-config/'+role+'/d';fs.mkdirSync(dir,{recursive:true,mode:0o700});
          const input='/run/ns-secret/'+role;
          const copy=(from,to)=>{
            for(const name of fs.readdirSync(from).filter(n=>!n.startsWith('.'))){
              const source=from+'/'+name,destination=to+'/'+name;
              if(role==='admin'&&from===input&&name==='verification'){
                fs.mkdirSync(destination,{mode:0o700});copy(source,destination);continue;
              }
              let bytes=fs.readFileSync(source);
              if(role==='admin'&&from===input&&name==='env.json'){const env=JSON.parse(bytes);env.ADMIN_HOSTNAME=process.env.NS_BIND_ADMIN_ADDRESS;bytes=Buffer.from(JSON.stringify(env));}
              fs.writeFileSync(destination,bytes,{mode:0o400,flag:'wx'});
            }
          };
          copy(input,dir);
        }
      |||] + roles,
      securityContext: hardened,
      volumeMounts: std.flattenArrays([
        [{ name: 'secret-' + r, mountPath: '/run/ns-secret/' + r, readOnly: true }, { name: 'config-' + r, mountPath: '/run/ns-config/' + r }]
        for r in roles
      ]) + (if ipc then [{ name: 'ns-ipc', mountPath: '/run/ns-ipc-volume' }] else []),
    },
    local configMount(role) = { name: 'config-' + role, mountPath: '/run/ns-config', subPath: 'd', readOnly: true },

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
      // Startup budget (Compose start_period 900s): readiness is not probed until this passes, so
      // a long tenant warm under NS_TENANT_READINESS=all is not cut short. Under the default
      // `serve` it passes once the role's own dependencies are up. 5 s x 180 = 900 s.
      [if std.member(['api', 'realtime', 'evaluator'], role) then 'startupProbe']: { exec: { command: ['node', 'deploy/multitenant/health.js', role] }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 180 },
      securityContext: hardened,
      volumeMounts: [
        configMount(role),
        { name: 'ns-ipc', mountPath: '/run/ns-ipc', subPath: 'd' },
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
                // Preserve docker-entrypoint.sh: it owns initdb before postgres starts.
                args: ['postgres', '-c', 'wal_level=logical', '-c', 'max_replication_slots=4', '-c', 'max_wal_senders=4', '-c', 'max_slot_wal_keep_size=256MB', '-c', 'output_plugin_libraries=wal2json', '-c', 'max_connections=140', '-c', 'reserved_connections=40'],
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
                // Compose: status 0 (unsealed) or 2 (sealed) is up; unseal is the provision Job's. Loopback
                // with the certificate's name: the Service name has no endpoint until this probe passes.
                readinessProbe: { exec: { command: ['sh', '-c', 'vault status -address=https://127.0.0.1:8200 -tls-server-name=vault -ca-cert=/run/ns-ca/ca.crt >/dev/null 2>&1; r=$?; [ "$r" -eq 0 ] || [ "$r" -eq 2 ]'] }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 },
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
      intakeService: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: meta('evaluator', 'cohort'),
        spec: { type: 'ClusterIP', publishNotReadyAddresses: true, selector: labels('cohort') + { 'statefulset.kubernetes.io/pod-name': 'cohort-0' }, ports: [{ name: 'stream-intake', port: 19913, targetPort: 'stream-intake' }] },
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
                installConfig(cohortRoles, ipc=true),
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
                roleContainer('evaluator', [{ name: 'stream-intake', containerPort: 19913 }], if c.evaluatorPool.partition == 'on' then [
                  { name: c.evaluatorPool.partitionEnv, value: 'on' },
                  { name: c.evaluatorPool.ordinalEnv, valueFrom: { fieldRef: { fieldPath: "metadata.labels['apps.kubernetes.io/pod-index']" } } },
                  // The member count: the pool table, via the coming operator command; not here.
                ] else []),
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
              terminationGracePeriodSeconds: c.cohort.terminationGraceSeconds,
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
              initContainers: [installConfig(['admin'])],
              containers: [{
                name: 'admin',
                image: c.images.app,
                imagePullPolicy: 'IfNotPresent',
                // Source-owned registry admin, with only the private bind address adapted.
                command: ['node', 'deploy/multitenant/entrypoint.js', 'admin'],

                ports: [{ name: 'int-admin', containerPort: 1342 }],
                env: [{ name: 'NODE_EXTRA_CA_CERTS', value: '/run/ns-ca/ca.crt' }],
                readinessProbe: { exec: { command: ['node', 'deploy/multitenant/health.js', 'admin'] }, periodSeconds: 2, timeoutSeconds: 3, failureThreshold: 30 },
                securityContext: hardened,
                volumeMounts: [configMount('admin'), caMount, tmpMount],
              }],
              volumes: configVolumes('admin') + [ca, tmp],
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
                command: ['node', '-r', './deploy/multitenant/load-env.js', 'deploy/multitenant/ui.js'],
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
      [if helper != null then 'bootstrapHelper']: {
        apiVersion: 'v1', kind: 'ConfigMap', immutable: true,
        metadata: meta('bootstrap-diagnostic', 'provision') + { annotations: helperAnnotations },
        data: { 'bootstrap.js': importstr '../../assets/bootstrap-helper.js' },
      },
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
          'candidate-documents.cjs': importstr '../../ops/candidate-documents.cjs',
          'source-contract.json': importstr '../../assets/source-contract.json',
          'network-documents.cjs': importstr '../../ops/network-documents.cjs',
        },
      },
      // Explicit provisioning, separate from serving startup. Steps run in order as init
      // containers; no retry (backoffLimit 0) so an uncertain result is never re-run silently.
      // Compose: bootstrap, vault-agent-bootstrap, ownership-grants (profile ops).
      job: {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: meta('provision', 'provision') + (if helper != null then { annotations: helperAnnotations } else {}),
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: c.provisionDeadlineSeconds,
          template: {
            metadata: { labels: labels('provision') } + (if helper != null then { annotations: helperAnnotations } else {}),
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
                  { name: 'NS_SOURCE_COMMIT', value: c.sourceCommit },
                  { name: 'NS_DEPLOY_COMMIT', value: if c.imageDeployCommit == null then c.sourceCommit else c.imageDeployCommit },
                ] + env,
                securityContext: hardened,
                volumeMounts: [
                  { name: 'state', mountPath: '/state' },
                  caMount,
                  { name: 'scripts', mountPath: '/run/ns-overlay', readOnly: true },
                  tmpMount,
                ] + (if name == 'bootstrap' then [{ name: 'postgres-password', mountPath: '/run/secrets', readOnly: true }] else []) +
                    (if helper != null && name == 'bootstrap' then [{
                      name: 'bootstrap-diagnostic', mountPath: helper.mountPath, subPath: 'bootstrap.js', readOnly: true,
                    }] else []),
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
                  { name: 'NS_PGSTREAM', value: '1' },
                  { name: 'NS_DEMO_TENANTS', value: std.toString(c.tenantCount) },
                  { name: 'NS_API_REPLICAS', value: '1' },
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

              ],
              containers: [
                // Keep this container alive for private tar export, including disposable state.
                // Publisher acknowledges only after every Secret has been created. No private log.
                step('done', ['node', '/run/ns-overlay/candidate-documents.cjs', 'hold'], [
                  { name: 'NS_APPLICATION_TOPOLOGY', value: c.applicationTopology },
                  { name: 'NS_FIXTURE_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                  { name: 'NS_FIXTURE_RUN_ID', valueFrom: { fieldRef: { fieldPath: "metadata.labels['nightscout.org/run-id']" } } },
                ]),
              ],
              volumes: [
                { name: 'state', persistentVolumeClaim: { claimName: 'provision-state' } },
                { name: 'postgres-password', secret: { secretName: 'ns-postgres-password', defaultMode: 288 } },
                ca,
                { name: 'scripts', configMap: { name: 'provision-scripts' } },
                tmp,
              ] + (if helper == null then [] else [{
                name: 'bootstrap-diagnostic', configMap: {
                  name: 'bootstrap-diagnostic', defaultMode: 292,
                },
              }]),
            },
          },
        },
      },
    },

    // Explicit tenant provisioning through the source-owned admin API. Apply/unsuspend
    // after document export and admin readiness. Verify before starting the serving cohort.
    primer: {
      job: {
        apiVersion: 'batch/v1', kind: 'Job', metadata: meta('primer', 'operator'),
        spec: { suspend: true, backoffLimit: 0, activeDeadlineSeconds: c.provisionDeadlineSeconds,
          template: { metadata: { labels: labels('operator') }, spec: {
            restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
            securityContext: podSecurity,
            initContainers: [installConfig(['primer']), { name: 'primer', image: c.images.app,
              command: ['node', 'deploy/multitenant/prime.js', 'provision'],
              env: [{ name: 'NS_PRIMER_STATE', value: '/run/ns-primer' }],
              securityContext: hardened,
              volumeMounts: [{ name: 'config-primer', mountPath: '/run/ns-primer', subPath: 'd' }, tmpMount],
            }],
            containers: [{ name: 'done', image: c.images.app, securityContext: hardened,
              command: ['node', '/run/ns-overlay/candidate-documents.cjs', 'verify'],
              env: [
                { name: 'NS_FIXTURE_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                { name: 'NS_FIXTURE_RUN_ID', valueFrom: { fieldRef: { fieldPath: "metadata.labels['nightscout.org/run-id']" } } },
              ],
              readinessProbe: { exec: { command: ['test', '-s', '/run/ns-primer/verified.json'] }, periodSeconds: 2 },
              volumeMounts: [{ name: 'config-primer', mountPath: '/run/ns-primer', subPath: 'd' },
                { name: 'scripts', mountPath: '/run/ns-overlay', readOnly: true }, tmpMount],
            }],
            volumes: configVolumes('primer') + [tmp, { name: 'scripts', configMap: { name: 'provision-scripts' } }],
          } },
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
      cohortFromOperator: np('cohort-from-operator', { matchLabels: labels('cohort') }, [sel('operator')], [{ port: 1337, protocol: 'TCP' }, { port: 1339, protocol: 'TCP' }]),
      cohortFromPgstream: np('cohort-from-pgstream', { matchLabels: labels('cohort') }, [sel('pgstream')], [{ port: 19913, protocol: 'TCP' }]),
      postgresFromApp: np('postgres-from-app', { matchLabels: labels('postgres') }, [sel('cohort'), sel('pgstream'), sel('admin'), sel('ui'), sel('provision')], [{ port: 5432, protocol: 'TCP' }]),
      vaultFromApp: np('vault-from-app', { matchLabels: labels('vault') }, [sel('cohort'), sel('admin'), sel('provision'), sel('vault')], [{ port: 8200, protocol: 'TCP' }]),
    },

    // ---------------------------------------------------------------- inventory (not applied)
    // Which PostgreSQL identity (<prefix>_<name>) each workload connects as, from the Compose
    // plan's per-role environment documents. check/invariants.js compares it with
    // ../compose/multitenant/config.js and the ownership overlay. Tanka ignores non-manifests.
    inventory:: {
      prefix: c.prefix,
      sourceCommit: c.sourceCommit,
      evaluatorPool: c.evaluatorPool,
      postgresIdentities: source.postgresIdentities,

    },
  },

  // Platform binding only: no role document construction or application lifecycle logic here.
  new(overrides)::
    local c = std.mergePatch($.defaults, overrides);
    local original = $.raw(overrides);
    assert std.member(['cohort', 'separate-k1'], c.applicationTopology) : 'unknown applicationTopology';
    local source = import '../../assets/source-contract.json';
    local helper = if std.objectHas(source, 'runtimeBootstrapHelper') then source.runtimeBootstrapHelper else null;
    assert std.member(['limits-v1', 'requests-v1'], c.resourceAccounting) : 'unknown resource accounting';
    local raw = if c.applicationTopology == 'separate-k1' then (import 'components.libsonnet').render(original, c) else original;
    local collect(v) = if std.isArray(v) then std.flattenArrays([collect(x) for x in v]) else if !std.isObject(v) then [] else if std.objectHas(v, 'apiVersion') && std.objectHas(v, 'kind') then [v] else std.flattenArrays([collect(v[k]) for k in std.objectFields(v)]);
    assert std.member(['standard', 'existing-capacity'], c.profile) : 'unknown profile';
    assert std.member(['dynamic', 'disposable', 'existing-claim'], c.storage.mode) : 'unknown storage mode';
    assert c.profile != 'existing-capacity' || (c.storage.mode != 'dynamic' && c.edge.serviceType == 'ClusterIP') : 'existing-capacity forbids dynamic storage and public Services';
    assert std.isNumber(c.tenantCount) && c.tenantCount >= 1 : 'tenantCount must be positive';
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
              { [k]: selected[k] for k in std.objectFields(selected) if k != 'limits' } +
              (if authored && overrides.resources[name].limits != null then { limits: overrides.resources[name].limits } else {})
            else selected;
          local containers(key) = [x + { resources: resources(x.name) } for x in spec[key]];
          local placement = c.placement + (if std.objectHas(c.placementByWorkload, name) then c.placementByWorkload[name] else {});
          { spec+: {
            template+: { metadata+: { labels+: ownership, annotations+: identity }, spec+: placement + {
              imagePullSecrets: c.imagePullSecrets,
              containers: containers('containers'),
              [if std.objectHas(spec,'initContainers') then 'initContainers']: containers('initContainers'),
              volumes: [if name == 'provision' && x.name == 'state' && c.storage.mode != 'dynamic' then stateVolume('provisionState','state') else x for x in spec.volumes] +
                (if c.storage.mode != 'dynamic' && std.member(['postgres','vault'],name) then [stateVolume(name,'data')] else []),
            } },
          } }
        else {})
      else { [k]: decorate(v[k]) for k in std.objectFields(v) if !(k == 'state' && std.objectHas(v,'job') && c.storage.mode != 'dynamic') };
    local rendered = decorate(raw);
    rendered + {
      inventory:: original.inventory + {
        applicationTopology: c.applicationTopology,
        schemaVersion: 1,
        namespace: c.namespace,
        runId: c.runId,
        bindingIdentity: c.bindingIdentity,
        imageDeployCommit: if c.imageDeployCommit == null then c.sourceCommit else c.imageDeployCommit,
        images: c.images,
        profile: c.profile,
        [if (import 'edge-configuration.libsonnet').selected(c.edge) then 'edgeConfiguration']: (import 'edge-configuration.libsonnet').record(c.edge),
        resourceAccounting: c.resourceAccounting,
        storage: c.storage,
        qualification: { application: 'INHERITED_SEPARATELY', cluster: 'UNMEASURED', capacity: 'UNMEASURED', persistence: 'UNMEASURED' },
        documents: {
          api: ['env.json','config.json','operation.json','evaluator-metadata.json','vault-token'],
          realtime: ['env.json','config.json','operation.json'],
          evaluator: ['env.json','config.json','operation.json'],
          'tenant-admin': ['env.json','config.json','operation.json','vault-token'],
          admin: ['env.json','config.json','vault-token','management-vault-token'] +
                 [item.path for item in rendered.admin.deployment.spec.template.spec.volumes[0].secret.items if std.startsWith(item.path, 'verification/')],
          ui: ['env.json','config.json'], pgstream: ['pgstream.yaml'], primer: ['config.json','expected-verification.json'],
        },
        ownership: { namespace: c.namespace, label: { 'nightscout.org/run-id': c.runId }, clusterScoped: [{ kind: 'ClusterRoleBinding', name: c.namespace + '-vault-tokenreview' }] },
        services: { [v.metadata.name]: { selector: v.spec.selector, type: if std.objectHas(v.spec,'type') then v.spec.type else 'ClusterIP', ports: if std.objectHas(v.spec,'ports') then v.spec.ports else [] } for v in [v for v in collect(rendered) if v.kind == 'Service'] },
        configMaps: ['vault-config','vault-agent-config','edge-nginx','provision-scripts'] + (if helper == null then [] else ['bootstrap-diagnostic']),
        candidateContract: {
          platformVerification: (import '../../assets/source-contract.json').platformVerification,
          diagnosticSha256: (import '../../assets/source-contract.json').diagnosticSha256,
          imageConfigId: (import '../../assets/source-contract.json').localImageId,
          producerBinarySha256: (import '../../assets/source-contract.json').producerBinarySha256,
          nativeCatalogueSha256: (import '../../assets/source-contract.json').nativeCatalogueSha256,
          sourceAcceptance: source.sourceAcceptance,
        } + (if helper == null then {} else {runtimeBootstrapHelper: helper, imageSourceAcceptance: source.imageSourceAcceptance}),
        imagePullSecrets: c.imagePullSecrets,
        placement: c.placement,
        placementByWorkload: c.placementByWorkload,
        export: { provision: { job: 'provision', container: 'done', readyFile: '/state/.ready', acknowledgeFile: '/state/.exported' }, primer: { job: 'primer', container: 'done', privateResult: '/run/ns-primer/provisioned.json', verificationProof: '/run/ns-primer/verified.json', acknowledgeFile: '/run/ns-primer/.exported' } },
        order: ['seed Secrets', 'apply stores and policies', 'apply provision Job', 'export documents and acknowledge', 'apply private admin', 'apply explicit primer Job and collect admin verification proof', 'apply serving workloads', 'observe correctness', 'delete only owned namespace and tokenreview binding'],
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
