'use strict';
// Fresh-only class identities and sealed file rosters. No login, grants at
// runtime, caller principal selector or old-ledger migration exists here.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util'),C=require('./control-recovery');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
function grants(layout){
 const q=require('./config').quote,n=layout.namespaces,who=q(layout.roles.restore_commissioner);
 // Dedicated setup authority can INSERT exact role-OID rows, never UPDATE a
 // revocation, alter roles, grant itself rights or mutate lifecycle windows.
 return ['GRANT USAGE ON SCHEMA '+q(n.control)+','+q(n.registry)+' TO '+who,
  'GRANT SELECT ON '+q(n.control)+'.tenant_lifecycle_windows,'+q(n.registry)+'.tenant_registry TO '+who,
  'GRANT SELECT,INSERT ON '+q(n.control)+'.tenant_lifecycle_restore_authority TO '+who];
}
function files({options,docs,layout,roleURLs,writePrivate}){
 const own={uid:options.uid,gid:options.gid},principals=options.controlRecoveryPrincipals;
 for(const name of C.CLASSES)C.principal(principals[name]);
 const fixed={version:1,operatorPrincipal:principals['lifecycle-operator'],tenants:docs.locks.map(r=>r.tenant),namespace:layout.namespaces.control,registryNamespace:layout.namespaces.registry};
 require('./restore-commissioner-action').config(fixed);
 writePrivate(path.join(options.output,'restore-commissioner','config.json'),fixed,own,{compact:true});
 writePrivate(path.join(options.output,'restore-commissioner','env.json'),{NS_COMMISSIONER_PG:roleURLs.restore_commissioner,NS_SOURCE_COMMIT:options.sourceCommit},own,{compact:true});
}
function identities(plan,options){
 need(plan.version===2&&plan.resource.allowances.controlRecovery===2&&(!plan.lifecycleOperator||plan.lifecycleOperator.version===2),'CONTROL_RECOVERY_VERSION');
 const principals=options.controlRecoveryPrincipals;
 need(principals&&equal(Object.keys(principals).sort(),[...C.CLASSES].sort()),'CONTROL_RECOVERY_PRINCIPAL');
 const identities=C.CLASSES.map(name=>C.principal(principals[name]));
 need(new Set(identities.map(p=>p.role)).size===3&&new Set(identities.map(p=>p.roleOid)).size===3,'CONTROL_RECOVERY_CLASS_PRINCIPAL');
 need(equal(options.lifecycleOperatorPrincipal,principals['lifecycle-operator']),'CONTROL_RECOVERY_PRINCIPAL');
 for(const p of identities)need(p.database===plan.workerDatabase.database&&p.databaseOid===plan.workerDatabase.databaseOid,'CONTROL_RECOVERY_WORKER_DATABASE');
 return principals;
}
function seal(plan,options){
 const principals=identities(plan,options);
 const config=require('./restore-commissioner-action').config(require('./connection-budget-files').read(path.join(options.output,'restore-commissioner','config.json')));
 const files={};for(const name of ['env.json','config.json']){const file=path.join(options.output,'restore-commissioner',name);require('./connection-budget-files').read(file);files[name]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
 return {...plan,controlRecovery:{version:1,classes:Object.fromEntries(C.CLASSES.map(name=>[name,{principal:structuredClone(principals[name])}]))},restoreCommissioner:{version:1,namespace:config.namespace,registryNamespace:config.registryNamespace,files}};
}
module.exports={grants,files,identities,seal};
