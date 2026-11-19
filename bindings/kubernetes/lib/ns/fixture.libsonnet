// Cold fixture copies. Operators own the decision to allocate storage and to stop all
// source writers before taking a set of four snapshots.
// Map the resulting destination PVC names into ns.new({storage:{mode:'existing-claim', claims:...}}).
local parts = ['postgres', 'vault', 'provisionState', 'primerResults'];
local check(claims) = std.sort(std.objectFields(claims)) == std.sort(parts);
local named(name, namespace, labels) = { name: name } + (if namespace == null then {} else { namespace: namespace }) +
                                       (if labels == {} then {} else { labels: labels });
local claim(namespace, name, size, storageClass, labels, dataSource) = {
  apiVersion: 'v1', kind: 'PersistentVolumeClaim',
  metadata: named(name, namespace, labels),
  spec: { accessModes: ['ReadWriteOnce'], storageClassName: storageClass,
          resources: { requests: { storage: size } } } +
        (if dataSource == null then {} else { dataSource: dataSource }),
};
{
  parts:: parts,
  snapshots(namespace, snapshotClass, sourceClaims, snapshotNames, labels={})::
    assert check(sourceClaims) && check(snapshotNames) : 'all four fixture parts are required';
    { [key]: {
        apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot',
        metadata: named(snapshotNames[key], namespace, labels),
        spec: { volumeSnapshotClassName: snapshotClass, source: { persistentVolumeClaimName: sourceClaims[key] } },
      } for key in parts },
  // The source objects expose the sizes, access modes and storage classes to
  // use. Reuse the source size or larger and the same CSI driver.
  claims(namespace, sourceKind, sourceNames, targetNames, sizes, storageClass, labels={})::
    assert std.member(['VolumeSnapshot', 'PersistentVolumeClaim'], sourceKind) : 'expected CSI snapshot or PVC clone';
    assert check(sourceNames) && check(targetNames) && check(sizes) : 'all four fixture parts are required';
    { [key]: claim(namespace, targetNames[key], sizes[key], storageClass, labels,
                   { kind: sourceKind, name: sourceNames[key] } +
                   (if sourceKind == 'VolumeSnapshot' then { apiGroup: 'snapshot.storage.k8s.io' } else {}))
      for key in parts },
  // Empty claims for the run that seeds a fixture.
  volumes(namespace, targetNames, sizes, storageClass, labels={})::
    assert check(targetNames) && check(sizes) : 'all four fixture parts are required';
    { [key]: claim(namespace, targetNames[key], sizes[key], storageClass, labels, null) for key in parts },
  // A VolumeSnapshot and a claim's dataSource are namespaced, so a fresh namespace cannot
  // name the seed's snapshots. Bind the retained provider snapshot handles statically: one
  // cluster-scoped VolumeSnapshotContent with deletionPolicy Retain (deleting it keeps the
  // provider snapshot) and one VolumeSnapshot per part. Delete the contents by label with the run.
  imported(namespace, driver, snapshotClass, handles, snapshotNames, labels)::
    assert check(handles) && check(snapshotNames) : 'all four fixture parts are required';
    { [key]: [
        {
          apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshotContent',
          metadata: named(namespace + '-' + snapshotNames[key], null, labels),
          spec: { deletionPolicy: 'Retain', driver: driver, volumeSnapshotClassName: snapshotClass,
                  source: { snapshotHandle: handles[key] },
                  volumeSnapshotRef: { name: snapshotNames[key], namespace: namespace } },
        },
        {
          apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot',
          metadata: named(snapshotNames[key], namespace, labels),
          spec: { volumeSnapshotClassName: snapshotClass,
                  source: { volumeSnapshotContentName: namespace + '-' + snapshotNames[key] } },
        },
      ] for key in parts },
}
