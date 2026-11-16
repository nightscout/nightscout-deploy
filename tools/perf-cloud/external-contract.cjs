'use strict';
// Runtime-safe constants. No build modules or arbitrary source loader are shipped
// to the controller hook merely to validate a finite public transfer interface.
const PROFILE='joined-external-generator-v1';
const TRAFFIC_FILES=['package.json','package-lock.json','tenants.private.json','probe.js','workload.js','recovery.cjs'].sort();
module.exports={PROFILE,TRAFFIC_FILES};
