// Cold, same-namespace fixture copies. Operators own the decision to allocate
// storage and to stop all source writers before taking a set of four snapshots.
// Map the resulting destination PVC names into ns.new({storage:{mode:'existing-claim', claims:...}}).
local parts = ['postgres', 'vault', 'provisionState', 'primerResults'];
local check(claims) = std.sort(std.objectFields(claims)) == std.sort(parts);
{
  snapshots(namespace, snapshotClass, sourceClaims, snapshotNames)::
    assert check(sourceClaims) && check(snapshotNames) : 'all four fixture parts are required';
    { [key]: {
        apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot',
        metadata: { name: snapshotNames[key], namespace: namespace },
        spec: { volumeSnapshotClassName: snapshotClass, source: { persistentVolumeClaimName: sourceClaims[key] } },
      } for key in parts },
  // The source objects expose the sizes, access modes and storage classes to
  // use. Reuse the source size or larger and the same CSI driver.
  claims(namespace, sourceKind, sourceNames, targetNames, sizes, storageClass)::
    assert std.member(['VolumeSnapshot', 'PersistentVolumeClaim'], sourceKind) : 'expected CSI snapshot or PVC clone';
    assert check(sourceNames) && check(targetNames) && check(sizes) : 'all four fixture parts are required';
    { [key]: {
        apiVersion: 'v1', kind: 'PersistentVolumeClaim',
        metadata: { name: targetNames[key], namespace: namespace },
        spec: { accessModes: ['ReadWriteOnce'], storageClassName: storageClass,
                resources: { requests: { storage: sizes[key] } },
                dataSource: { kind: sourceKind, name: sourceNames[key] } +
                            (if sourceKind == 'VolumeSnapshot' then { apiGroup: 'snapshot.storage.k8s.io' } else {}) },
      } for key in parts },
}
