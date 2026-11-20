// Opt-in lab metrics for one run namespace (alignment decision prometheus-metrics-narrow).
// Off by default; off, nothing here renders and the namespace is byte-identical to a render
// without this file. On (labMetrics.enabled):
//   - every application role gets NS_METRICS=true (core serves GET /metrics on its private
//     listener, container port int-role, beside /healthz/*);
//   - one Prometheus Deployment scrapes each role Pod through its `<role>-internal` Service
//     (EndpointSlice discovery, publishNotReadyAddresses), so each evaluator ordinal is its own
//     target, and the postgres_exporter sidecar through Pod discovery;
//   - a postgres_exporter sidecar in the postgres Pod connects over the shared Unix socket as the
//     local superuser (local trust, no password file), with pg_stat_statements (query text, top
//     100 by time), replication slots and the lab queries below (walsender waits, slot lag,
//     pg_stat_io, backends by state and wait per source-owned application_name);
//   - a postStart hook creates the pg_stat_statements extension in database `postgres` (never the
//     application database) once the server answers; the binding already preloads the module.
// Namespace-scoped only: one Role (get/list/watch Pods, Services, EndpointSlices) and its
// RoleBinding. No cluster-wide operator, no kube-prometheus-stack, no Grafana. The admin API is on
// so the controller can take a TSDB snapshot before teardown; the Service is ClusterIP only.
{
  defaults:: {
    enabled: false,
    scrapeSeconds: 5,
    retention: '24h',
    storage: '1Gi',
    images: {
      prometheus: 'prom/prometheus@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996',  // v3.5.0
      postgresExporter: 'quay.io/prometheuscommunity/postgres-exporter@sha256:e8a170b85eab07c75c2b0f3aa2806be5c2fe5bba46fd0336914e1f36572cde08',  // v0.19.0
    },
  },
  roles:: ['api', 'evaluator', 'realtime', 'tenant-admin'],
  port:: 9090,
  exporterPort:: 9187,
  socket:: '/var/run/postgresql',
  // The binding's container hardening (Compose read_only, cap_drop ALL, user 1000).
  hardened:: { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, readOnlyRootFilesystem: true,
               allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },

  settings(c):: std.mergePatch($.defaults, std.get(c, 'labMetrics', {})),
  enabled(c):: $.settings(c).enabled == true,

  // Rows appended to each application role's environment.
  roleEnv(c):: if $.enabled(c) then [{ name: 'NS_METRICS', value: 'true' }] else [],
  // Extra callers of each role's private listener.
  callers(c):: if $.enabled(c) then ['metrics'] else [],

  // Lab queries: names are <query>_<column>. application_name is reported only when it is a
  // source-owned nightscout-* name (core's metrics allow-list), else 'other'.
  queries:: |||
    ns_walsender:
      query: "SELECT coalesce(state, 'none') AS state, coalesce(wait_event_type, 'CPU') AS wait_event_type, coalesce(wait_event, 'CPU') AS wait_event, count(*)::float8 AS senders FROM pg_stat_activity WHERE backend_type = 'walsender' GROUP BY 1, 2, 3"
      metrics:
        - state: {usage: LABEL, description: "walsender state"}
        - wait_event_type: {usage: LABEL, description: "wait event type, CPU when none"}
        - wait_event: {usage: LABEL, description: "wait event, CPU when none"}
        - senders: {usage: GAUGE, description: "walsenders in this state and wait at scrape time"}
    ns_slot:
      query: "SELECT slot_name, active::int::float8 AS active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::float8 AS confirmed_lag_bytes, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::float8 AS retained_wal_bytes FROM pg_replication_slots WHERE NOT temporary"
      metrics:
        - slot_name: {usage: LABEL, description: "replication slot"}
        - active: {usage: GAUGE, description: "1 when a consumer is attached"}
        - confirmed_lag_bytes: {usage: GAUGE, description: "current WAL position minus the slot's confirmed flush position"}
        - retained_wal_bytes: {usage: GAUGE, description: "current WAL position minus the slot's restart position"}
    ns_activity:
      query: "SELECT coalesce(backend_type, 'unknown') AS backend_type, CASE WHEN application_name ~ '^nightscout-[a-z][a-z0-9-]{0,47}$' THEN application_name WHEN application_name = '' THEN 'none' ELSE 'other' END AS application_name, coalesce(state, 'none') AS state, coalesce(wait_event_type, 'CPU') AS wait_event_type, count(*)::float8 AS backends FROM pg_stat_activity WHERE pid <> pg_backend_pid() GROUP BY 1, 2, 3, 4"
      metrics:
        - backend_type: {usage: LABEL, description: "backend type"}
        - application_name: {usage: LABEL, description: "source-owned application_name or other"}
        - state: {usage: LABEL, description: "state"}
        - wait_event_type: {usage: LABEL, description: "wait event type, CPU when none"}
        - backends: {usage: GAUGE, description: "backends at scrape time"}
    ns_stat_io:
      query: "SELECT backend_type, object, context, coalesce(reads, 0)::float8 AS reads, coalesce(read_time, 0) / 1000.0 AS read_seconds, coalesce(writes, 0)::float8 AS writes, coalesce(write_time, 0) / 1000.0 AS write_seconds, coalesce(extends, 0)::float8 AS extends, coalesce(hits, 0)::float8 AS hits, coalesce(evictions, 0)::float8 AS evictions, coalesce(fsyncs, 0)::float8 AS fsyncs, coalesce(fsync_time, 0) / 1000.0 AS fsync_seconds FROM pg_stat_io"
      metrics:
        - backend_type: {usage: LABEL, description: "backend type"}
        - object: {usage: LABEL, description: "relation kind"}
        - context: {usage: LABEL, description: "I/O context"}
        - reads: {usage: COUNTER, description: "read operations"}
        - read_seconds: {usage: COUNTER, description: "time in reads (track_io_timing)"}
        - writes: {usage: COUNTER, description: "write operations"}
        - write_seconds: {usage: COUNTER, description: "time in writes (track_io_timing)"}
        - extends: {usage: COUNTER, description: "relation extend operations"}
        - hits: {usage: COUNTER, description: "shared buffer hits"}
        - evictions: {usage: COUNTER, description: "buffer evictions"}
        - fsyncs: {usage: COUNTER, description: "fsync calls"}
        - fsync_seconds: {usage: COUNTER, description: "time in fsync (track_io_timing)"}
  |||,

  config(c, namespace):: |||
    global:
      scrape_interval: %(interval)ds
      scrape_timeout: %(timeout)ds
    scrape_configs:
      - job_name: roles
        kubernetes_sd_configs:
          - role: endpointslice
            namespaces: {names: [%(namespace)s]}
        relabel_configs:
          - source_labels: [__meta_kubernetes_service_name]
            regex: (api|evaluator|realtime|tenant-admin)-internal
            action: keep
          - source_labels: [__meta_kubernetes_endpointslice_port_name]
            regex: internal
            action: keep
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod
          - source_labels: [__meta_kubernetes_service_name]
            regex: (.+)-internal
            target_label: workload
      - job_name: postgres
        kubernetes_sd_configs:
          - role: pod
            namespaces: {names: [%(namespace)s]}
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_container_port_name]
            regex: pg-metrics
            action: keep
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod
      - job_name: prometheus
        static_configs:
          - targets: ['127.0.0.1:%(port)d']
  ||| % { interval: $.settings(c).scrapeSeconds, timeout: std.max(1, $.settings(c).scrapeSeconds - 1), namespace: namespace, port: $.port },

  // The postgres StatefulSet with the exporter sidecar, the shared socket and the extension hook.
  postgres(postgres, c):: if !$.enabled(c) then postgres else postgres + {
    statefulset+: { spec+: { template+: { spec+: {
      containers: [x + (if x.name != 'postgres' then {} else {
        volumeMounts+: [{ name: 'pg-socket', mountPath: $.socket }],
        lifecycle: { postStart: { exec: { command: ['sh', '-c',
          'for i in $(seq 1 900); do if pg_isready -q -h ' + $.socket + '; then psql -X -qAt -h ' + $.socket +
          ' -U postgres -d postgres -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" && exit 0; fi; sleep 1; done; exit 0'] } } },
      }) for x in super.containers] + [{
        name: 'postgres-exporter',
        image: $.settings(c).images.postgresExporter,
        imagePullPolicy: 'IfNotPresent',
        args: ['--web.listen-address=:' + $.exporterPort, '--collector.stat_statements', '--collector.stat_statements.include_query',
               '--collector.stat_statements.limit=100', '--extend.query-path=/etc/postgres-exporter/queries.yaml'],
        env: [{ name: 'DATA_SOURCE_NAME', value: 'host=' + $.socket + ' user=postgres dbname=postgres sslmode=disable' }],
        ports: [{ name: 'pg-metrics', containerPort: $.exporterPort }],
        securityContext: $.hardened,
        volumeMounts: [{ name: 'pg-socket', mountPath: $.socket }, { name: 'exporter-queries', mountPath: '/etc/postgres-exporter', readOnly: true }],
      }],
      volumes+: [{ name: 'pg-socket', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
                 { name: 'exporter-queries', configMap: { name: 'postgres-exporter-queries' } }],
    } } } },
  },

  // The Prometheus server, its namespace-only discovery grant and its policies.
  render(c, namespace, labels):: if !$.enabled(c) then {} else
    local s = $.settings(c);
    local meta(name) = { name: name, namespace: namespace, labels: labels('metrics') };
    {
      serviceAccount: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('prometheus') },
      role: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: meta('prometheus-discovery'),
        rules: [{ apiGroups: [''], resources: ['pods', 'services', 'endpoints'], verbs: ['get', 'list', 'watch'] },
                { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list', 'watch'] }] },
      roleBinding: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: meta('prometheus-discovery'),
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'prometheus-discovery' },
        subjects: [{ kind: 'ServiceAccount', name: 'prometheus', namespace: namespace }] },
      config: { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('prometheus-config'), data: { 'prometheus.yml': $.config(c, namespace) } },
      queries: { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('postgres-exporter-queries'), data: { 'queries.yaml': $.queries } },
      deployment: {
        apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta('prometheus'),
        spec: {
          replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: labels('metrics') },
          template: {
            metadata: { labels: labels('metrics') },
            spec: {
              serviceAccountName: 'prometheus',
              enableServiceLinks: false,
              securityContext: { fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
              containers: [{
                name: 'prometheus',
                image: s.images.prometheus,
                imagePullPolicy: 'IfNotPresent',
                args: ['--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.path=/prometheus',
                       '--storage.tsdb.retention.time=' + s.retention, '--web.listen-address=:' + $.port, '--web.enable-admin-api'],
                ports: [{ name: 'http-metrics', containerPort: $.port }],
                readinessProbe: { httpGet: { path: '/-/ready', port: 'http-metrics' }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 60 },
                securityContext: $.hardened,
                volumeMounts: [{ name: 'config', mountPath: '/etc/prometheus', readOnly: true }, { name: 'data', mountPath: '/prometheus' }],
              }],
              volumes: [{ name: 'config', configMap: { name: 'prometheus-config' } }, { name: 'data', emptyDir: { sizeLimit: s.storage } }],
            },
          },
        },
      },
      service: { apiVersion: 'v1', kind: 'Service', metadata: meta('prometheus'),
        spec: { type: 'ClusterIP', selector: labels('metrics'), ports: [{ name: 'http', port: $.port, targetPort: 'http-metrics' }] } },
    },

  // Ingress: the exporter from Prometheus; Prometheus from the operator.
  policies(c, policy):: if !$.enabled(c) then {} else {
    postgresMetrics: policy('postgres-metrics', 'postgres', ['metrics'], [$.exporterPort]),
    prometheusFromOperator: policy('prometheus-from-operator', 'metrics', ['operator'], [$.port]),
  },
}
