'use strict';
// Synthetic fixture administration only. This is not an operator API or a
// shipping owner bootstrap. Settings values are NEVER written by this setup.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const q=name=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(name))throw new Error('FIXTURE_IDENTIFIER_REFUSED');return '"'+name+'"';};
function command({core,state,project},sql){
 if(!/^ns-evaluator-binding-proof-[0-9]{8}(?:-[a-z][a-z0-9]{0,15})?$/.test(project))throw new Error('FIXTURE_PROJECT_REFUSED');
 const files=require('./shipping-compose-files.cjs').files({core,state});
 const args=['compose','-p',project,'--env-file','.env',...files.flatMap(file=>['-f',file]),'exec','-T','postgres','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','nightscout_compose_test'];
 try{execFileSync('docker',args,{cwd:path.join(core,'deploy/multitenant'),input:sql,stdio:['pipe','pipe','pipe']});}
 catch{throw Object.assign(new Error('EVALUATOR_SETTINGS_FIXTURE_ADMIN_REFUSED'),{code:'EVALUATOR_SETTINGS_FIXTURE_ADMIN_REFUSED'});}
}
function setup(options){
 const {state,project}=options;
 if(!/^ns-evaluator-binding-proof-[0-9]{8}(?:-[a-z][a-z0-9]{0,15})?$/.test(project))throw new Error('FIXTURE_PROJECT_REFUSED');
 const layout=JSON.parse(fs.readFileSync(path.join(state,'bootstrap/layout.json'),'utf8'));
 const file=path.join(state,'bootstrap/evaluator-settings-control.json');
 if(fs.existsSync(file))throw new Error('FIXTURE_SETTINGS_ALREADY_PREPARED');
 const env=JSON.parse(fs.readFileSync(path.join(state,'tenant-admin/env.json'),'utf8'));
 const tenants=JSON.parse(fs.readFileSync(path.join(state,'primer/tenants.json'),'utf8')).tenants;
 const ns={settings:layout.namespaces.display_settings,operatorPolicy:layout.namespaces.operator_policy,authority:layout.namespaces.owner_configuration};
 const role=layout.prefix+'_evaluator_fixture',password=crypto.randomBytes(24).toString('hex'),consumer='evaluator-binding-proof';
 const actors=tenants.map((tenant,index)=>({tenant:tenant.id,principal:'synthetic-evaluator-owner-'+index,consumer}));
 const table=(namespace,name)=>q(namespace)+'.'+q(name),who=q(role);
 const sql=['BEGIN','CREATE ROLE '+who+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+password+"'"];
 for(const namespace of Object.values(ns))sql.push('GRANT USAGE ON SCHEMA '+q(namespace)+' TO '+who,'GRANT SELECT ON '+table(namespace,'schema_migrations')+' TO '+who);
 sql.push('GRANT SELECT,INSERT,UPDATE ON '+table(ns.settings,'tenant_settings')+' TO '+who,
  'GRANT SELECT,INSERT ON '+table(ns.settings,'tenant_settings_history')+' TO '+who,
  'GRANT SELECT ON '+table(ns.operatorPolicy,'tenant_operator_policy')+' TO '+who,
  'GRANT SELECT,UPDATE(owner_fence) ON '+table(ns.authority,'tenant_owner_configuration_authority')+' TO '+who,
  'GRANT EXECUTE ON FUNCTION '+q(ns.settings)+'.tenant_settings_values_valid(jsonb) TO '+who,
  'GRANT USAGE ON SCHEMA '+q(layout.namespaces.control)+' TO '+who);
 for(const name of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])sql.push('GRANT SELECT ON '+table(layout.namespaces.control,name)+' TO '+who);
 for(const actor of actors){
  if(!/^[0-9a-f-]{36}$/.test(actor.tenant))throw new Error('FIXTURE_TENANT_REFUSED');
  sql.push("SELECT set_config('app.current_tenant_id','"+actor.tenant+"',true)",
   'INSERT INTO '+table(ns.authority,'tenant_owner_configuration_authority')+"(tenant_id,principal,consumer,active,can_configure) VALUES('"+actor.tenant+"','"+actor.principal+"','"+consumer+"',true,true)");
 }
 sql.push('COMMIT');command(options,sql.join(';\n')+';\n');
 const url=new URL(env.NS_OWNER_WRITER_PG);url.username=role;url.password=password;
 fs.writeFileSync(file,JSON.stringify({connectionString:url.toString(),lifetimeUrl:env.NS_LIFETIME_PG,controlNamespace:layout.namespaces.control,namespaces:ns,actors,consumer})+'\n',{mode:0o600,flag:'wx'});
 return {file,role,namespaces:ns,actors};
}
function authority(options,actor,active){
 if(typeof active!=='boolean')throw new Error('FIXTURE_AUTHORITY_STATE_REFUSED');
 const selected=JSON.parse(fs.readFileSync(path.join(options.state,'bootstrap/evaluator-settings-control.json'),'utf8'));
 if(!selected.actors.some(row=>JSON.stringify(row)===JSON.stringify(actor)))throw new Error('FIXTURE_ACTOR_REFUSED');
 command(options,'BEGIN; SELECT set_config(\'app.current_tenant_id\',\''+actor.tenant+'\',true); UPDATE '+q(selected.namespaces.authority)+'.tenant_owner_configuration_authority SET active='+String(active)+',can_configure='+String(active)+" WHERE tenant_id='"+actor.tenant+"' AND principal='"+actor.principal+"' AND consumer='"+actor.consumer+"'; COMMIT;");
}
module.exports={setup,authority,command};
