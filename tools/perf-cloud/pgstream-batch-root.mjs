// Root interface for the existing controller/provider primitives, not an allocator.
// Install the trusted authority/custody gateways in the reviewed root hook. Never
// construct them from request JSON. An approval file, fixture, controller claim,
// or this module alone cannot authorize provider actions. Tool review still applies.
//
// Before creating anything: reserveBeforeAllocation(batchId, cellId), then
// markCreateAttempt. Existing owned primitives create/bind resources; bindAllocation
// records independently observed IDs, keys, guard birth and source/host binding.
// An attempted/uncertain create conservatively counts its live hourly upper until
// independently absent; it cannot be retried under the same reservation. Invoice
// cost is never inferred from that upper. Unattempted reservations alone can refund
// their unused upper; allocated/uncertain runs retain it once after cleanup.
// The controller's three dispatch operations consume those existing reservations.
// Cancellation stops new claims and delegates exact cleanup to the existing guard.
// No provider credential, SSH command, resource creation or implicit authority here.
//
// Gateway contract (all amounts in integer micro-USD; clocks in epoch seconds):
// authority.reviewedIntent(id) returns {source:{kind:'direct-user-message',chatId,
// messageId},receiptSha256,intentSha256,intent:{version:1,id,payload,envelope,cells}}.
// Cells bind id/namespace/nonce/target/resources, creationNotBefore/After,
// cleanupAt and cost:{computeUpperMicrousd,feesEgressCleanupUpperMicrousd}.
// authority.boundPlan(id) independently binds that intent to assigned host IDs:
// {intentSha256,planSha256,projectionSha256:batchDigest(plan),receiptSha256,
// cells:{[id]:{cellSha256,providerIds,sourceHostBindingSha256}}}.
// A bound plan is a root observation, not a fresh human permission claim.
// custody.beforeAllocation/observe return fresh exact guard PID/startTicks,
// namespace/nonce/key custody and covered IDs. observe additionally verifies the
// approved target and actual source/SSH/NIC binding. absence queries the actual
// provider/key/guard process group independently, including unknown-create recovery
// by exact namespace/nonce/time; recoveryVerified cannot come from controller JSON.
// These gateways and cleanupOwned wrap the reviewed existing root primitives.
// Their production installation is a separate explicit integration boundary;
// synthetic gateways in tests qualify only this module's source behavior.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {batchDigest} from './pgstream-caller.mjs';

const need=(v,c)=>{if(!v)throw Error('PGCAL_ROOT_'+c);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const clone=v=>structuredClone(v);
const ids=hosts=>Object.values(hosts).map(h=>String(h.providerId)).sort();
const money=v=>{need(Number.isFinite(v)&&v>=0,'LEDGER_MONEY');const n=Math.round(v*1e6);need(Number.isSafeInteger(n)&&Math.abs(n/1e6-v)<1e-9,'LEDGER_MONEY');return n;};
const usd=v=>v/1e6;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const ROOT='pgstreamBatchRoot';

// Real file-backed transaction: one global flock, read/hash, compare again before
// atomic replace. No stale-lock stealing. Parent failure closes stdin/releases lock.
// Tests point this at temporary synthetic ledgers, never the authoritative ledger.
const LEDGER_TRANSACTION=String.raw`
import os,sys,json,hashlib,fcntl,time,tempfile,pathlib
p=pathlib.Path(sys.argv[1]); lock=pathlib.Path(str(p)+'.lock')
fd=os.open(lock,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
deadline=time.monotonic()+5
while True:
 try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);break
 except BlockingIOError:
  if time.monotonic()>=deadline:raise RuntimeError('PGCAL_ROOT_LEDGER_LOCK_TIMEOUT')
  time.sleep(.01)
def read():
 f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(f,'rb') as s:return s.read(8388609)
raw=read();assert len(raw)<=8388608,'PGCAL_ROOT_LEDGER_BOUND'
sha=hashlib.sha256(raw).hexdigest()
print(json.dumps({'sha256':sha,'value':json.loads(raw)}),flush=True)
line=sys.stdin.buffer.readline(8388609)
if not line:sys.exit(0)
assert len(line)<=8388608,'PGCAL_ROOT_LEDGER_BOUND'
request=json.loads(line);assert request['expectedSha256']==sha and hashlib.sha256(read()).hexdigest()==sha,'PGCAL_ROOT_LEDGER_CAS'
if request.get('unchanged'):print(json.dumps({'committed':False}),flush=True);sys.exit(0)
temp=None
try:
 with tempfile.NamedTemporaryFile('w',dir=p.parent,prefix=p.name+'.root-',delete=False) as s:
  temp=s.name;os.fchmod(s.fileno(),0o600);json.dump(request['value'],s,indent=2);s.write('\n');s.flush();os.fsync(s.fileno())
 os.replace(temp,p);temp=None
 directory=os.open(p.parent,os.O_DIRECTORY);os.fsync(directory);os.close(directory)
 print(json.dumps({'committed':True}),flush=True)
finally:
 if temp:os.unlink(temp)
`;
export function fileLedger(ledgerPath){
  need(typeof ledgerPath==='string'&&ledgerPath.startsWith('/'),'LEDGER_PATH');
  return {async transaction(update){
    const child=spawn('python3',['-c',LEDGER_TRANSACTION,ledgerPath],{stdio:['pipe','pipe','pipe']});
    let stderr='';child.stderr.on('data',b=>{if(stderr.length<8192)stderr+=b;});
    const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(stderr.includes('PGCAL_ROOT_LEDGER_CAS')?'PGCAL_ROOT_LEDGER_CAS':'PGCAL_ROOT_LEDGER_TRANSACTION_FAILED')));});
    exit.catch(()=>{});const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    try{
      const first=await lines.next();need(!first.done,'LEDGER_READ');const initial=JSON.parse(first.value),value=clone(initial.value);
      const result=await update(value);const unchanged=equal(value,initial.value);
      child.stdin.end(JSON.stringify({expectedSha256:initial.sha256,value,unchanged})+'\n');
      const receipt=await lines.next();if(receipt.done)await exit;need(!receipt.done,'LEDGER_COMMIT');await exit;return result;
    }catch(error){child.stdin.end();await exit.catch(()=>{});throw error;}finally{clearTimeout(timer);}
  }};
}

export function rootAdapter({ledger,authority,custody,cleanupOwned,now=()=>Date.now()/1000,newToken=randomUUID}){
  need(typeof ledger?.transaction==='function'&&typeof authority?.reviewedIntent==='function'&&typeof authority?.boundPlan==='function','TRUSTED_GATEWAYS_REQUIRED');
  need(typeof custody?.beforeAllocation==='function'&&typeof custody?.observe==='function'&&typeof custody?.absence==='function'&&typeof cleanupOwned==='function','CUSTODY_GATEWAYS_REQUIRED');
  const fresh=at=>Number.isFinite(at)&&at<=now()&&now()-at<=30;
  async function approval(batchId){
    // Only the installed gateway reads direct-user evidence. Request-supplied
    // approved:true, authority receipts and final provider IDs are never inputs.
    const a=await authority.reviewedIntent(batchId);
    need(a?.source?.kind==='direct-user-message'&&typeof a.source.chatId==='string'&&!!a.source.chatId&&typeof a.source.messageId==='string'&&!!a.source.messageId&&hash(a.receiptSha256),'DIRECT_AUTHORITY_REQUIRED');
    need(a.intent?.version===1&&a.intent.id===batchId&&hash(a.intentSha256)&&batchDigest(a.intent)===a.intentSha256,'INTENT_CHANGED');
    const i=a.intent,e=i.envelope;need(i.payload&&Array.isArray(i.payload.files)&&i.payload.files.length>0&&new Set(i.payload.files.map(f=>f.path)).size===i.payload.files.length&&i.payload.files.every(f=>typeof f.path==='string'&&!f.path.startsWith('/')&&!f.path.split('/').includes('..')&&hash(f.sha256)),'PAYLOAD_ALLOWLIST');
    need(e&&positive(e.hourlyMicrousd)&&positive(e.totalMicrousd)&&Number.isFinite(e.cleanupAt)&&e.cleanupAt>now(),'AUTHORITY_EXPIRED');
    need(Array.isArray(i.cells)&&i.cells.length>0&&new Set(i.cells.map(c=>c.id)).size===i.cells.length&&new Set(i.cells.map(c=>c.namespace)).size===i.cells.length&&new Set(i.cells.map(c=>c.nonce)).size===i.cells.length,'INTENT_CUSTODY_COLLISION');
    need(i.cells.every(c=>typeof c.id==='string'&&typeof c.namespace==='string'&&/^[a-f0-9]{32}$/.test(c.nonce)&&c.target?.maxResources===2&&positive(c.resources?.hourlyMicrousd)&&positive(c.resources?.totalMicrousd)&&c.cleanupAt<=e.cleanupAt&&c.cleanupAt>now()),'INTENT_CELL');
    need(i.cells.every(c=>Number.isFinite(c.creationNotBefore)&&Number.isFinite(c.creationNotAfter)&&c.creationNotBefore<c.creationNotAfter&&c.creationNotAfter<c.cleanupAt&&positive(c.cost?.computeUpperMicrousd)&&Number.isSafeInteger(c.cost?.feesEgressCleanupUpperMicrousd)&&c.cost.feesEgressCleanupUpperMicrousd>=0&&c.cost.computeUpperMicrousd>=Math.ceil(c.resources.hourlyMicrousd*(c.cleanupAt-c.creationNotBefore)/3600)&&c.cost.computeUpperMicrousd+c.cost.feesEgressCleanupUpperMicrousd<=c.resources.totalMicrousd),'COST_OR_CREATION_WINDOW');
    need(i.cells.reduce((s,c)=>s+c.resources.hourlyMicrousd,0)<=e.hourlyMicrousd&&i.cells.reduce((s,c)=>s+c.resources.totalMicrousd,0)<=e.totalMicrousd,'INTENT_OVERCOMMIT');
    return a;
  }
  function state(v,a,create=false){
    const all=v[ROOT]??(create?(v[ROOT]={}):{});let s=all[a.intent.id];
    if(!s&&create)s=all[a.intent.id]={intentSha256:a.intentSha256,authoritySha256:a.receiptSha256,status:'OPEN',cells:{}};
    need(s&&s.intentSha256===a.intentSha256&&s.authoritySha256===a.receiptSha256,'AUTHORITY_CHANGED');return s;
  }
  function guard(g,cell){
    need(g?.status==='ARMED'&&g.namespace===cell.namespace&&g.nonce===cell.nonce&&fresh(g.observedAt)&&Number.isSafeInteger(g.pid)&&g.pid>0&&typeof g.startTicks==='string'&&g.startTicks.length>0&&g.sameBirth===true&&g.keyCustody===true&&g.cleanupAt<=cell.cleanupAt&&g.cleanupAt>now()&&hash(g.receiptSha256),'GUARD_CUSTODY');
  }
  function exactGuard(g,record,cell){guard(g,cell);need(g.pid===record.guard.pid&&g.startTicks===record.guard.startTicks,'STALE_GUARD_BIRTH');}
  async function reserveBeforeAllocation(batchId,cellId){
    const a=await approval(batchId),cell=a.intent.cells.find(c=>c.id===cellId);need(cell,'UNAPPROVED_CELL');
    const g=await custody.beforeAllocation({intent:clone(a.intent),cell:clone(cell)});guard(g,cell);need(Array.isArray(g.providerIds)&&g.providerIds.length===0,'PREALLOCATION_IDS');
    return ledger.transaction(v=>{
      const s=state(v,a,true);need(s.status==='OPEN','BATCH_CANCELLED');const prior=s.cells[cellId];
      if(prior){need(prior.intentCellSha256===batchDigest(cell)&&prior.state!=='RELEASED','CONTRADICTORY_REPLAY');exactGuard(g,prior,cell);return {status:'RESERVED',token:prior.token};}
      const hourly=money(v.reservedAggregateHourlyUSD??0),actual=money(v.currentAggregateHourlyUSD??0),total=money(v.totalReservedUpperUSD),remaining=money(v.uncommittedUpperBudgetUSD);
      need(Math.max(hourly,actual)+cell.resources.hourlyMicrousd<=money(v.maximumAggregateHourlyUSD),'GLOBAL_HOURLY_OVERCOMMIT');
      need(total+cell.resources.totalMicrousd<=money(v.maximumTotalUSD)&&remaining>=cell.resources.totalMicrousd,'GLOBAL_TOTAL_OVERCOMMIT');
      const hard=Date.parse(v.hardAllPaidResourcesAbsentUTC)/1000;need(Number.isFinite(hard)&&cell.cleanupAt<=hard,'GLOBAL_DEADLINE');
      // The same namespace/nonce cannot be charged or controlled by another batch.
      for(const b of Object.values(v[ROOT]))for(const r of Object.values(b.cells))if(r.state!=='RELEASED')need(r.namespace!==cell.namespace&&r.nonce!==cell.nonce,'GLOBAL_CUSTODY_COLLISION');
      const token=newToken();need(typeof token==='string'&&token.length>0,'RESERVATION_TOKEN');
      s.cells[cellId]={token,state:'RESERVED',intentCellSha256:batchDigest(cell),namespace:cell.namespace,nonce:cell.nonce,resources:clone(cell.resources),guard:clone(g),attempted:false,providerIds:[]};
      v.reservedAggregateHourlyUSD=usd(hourly+cell.resources.hourlyMicrousd);v.totalReservedUpperUSD=usd(total+cell.resources.totalMicrousd);v.uncommittedUpperBudgetUSD=usd(remaining-cell.resources.totalMicrousd);
      return {status:'RESERVED',token};
    });
  }
  async function markCreateAttempt(batchId,cellId,token){
    const a=await approval(batchId),cell=a.intent.cells.find(c=>c.id===cellId);need(cell,'UNAPPROVED_CELL');const g=await custody.beforeAllocation({intent:clone(a.intent),cell:clone(cell)});
    need(now()>=cell.creationNotBefore&&now()<cell.creationNotAfter,'CREATE_WINDOW');
    return ledger.transaction(v=>{const s=state(v,a),r=s.cells[cellId];need(s.status==='OPEN'&&r?.token===token&&r.state==='RESERVED','CREATE_CUSTODY');need(!r.attempted,'CREATE_ALREADY_ATTEMPTED');exactGuard(g,r,cell);need(Array.isArray(g.providerIds)&&g.providerIds.length===0,'PREALLOCATION_IDS');r.attempted=true;r.actualHourlyCharged=true;r.actualCostQualification='UPPER_BOUND_CREATE_ATTEMPT_UNCERTAIN';v.currentAggregateHourlyUSD=usd(money(v.currentAggregateHourlyUSD??0)+r.resources.hourlyMicrousd);return {status:'ATTEMPT_RECORDED'};});
  }
  async function bindAllocation(batchId,cellId,token){
    const a=await approval(batchId),cell=a.intent.cells.find(c=>c.id===cellId);need(cell,'UNAPPROVED_CELL');
    const observation=await custody.observe({batchId,cellId,cell:clone(cell)});guard(observation.guard,cell);
    need(observation.namespace===cell.namespace&&observation.nonce===cell.nonce&&observation.targetMatches===true&&observation.sourceHostBindingVerified===true&&hash(observation.sourceHostBindingSha256)&&Array.isArray(observation.providerIds)&&observation.providerIds.length===2&&new Set(observation.providerIds).size===2&&observation.providerIds.every(x=>typeof x==='string'&&x.length>0)&&Array.isArray(observation.guard.providerIds)&&equal([...observation.guard.providerIds].sort(),[...observation.providerIds].sort()),'ALLOCATION_BINDING');
    return ledger.transaction(v=>{
      const s=state(v,a),r=s.cells[cellId];need(s.status==='OPEN'&&r?.token===token&&r.attempted&&['RESERVED','BOUND'].includes(r.state),'ALLOCATION_CUSTODY');exactGuard(observation.guard,r,cell);
      const actual=[...observation.providerIds].sort();if(r.state==='BOUND'){need(equal(r.providerIds,actual)&&r.sourceHostBindingSha256===observation.sourceHostBindingSha256,'ALLOCATION_CHANGED');return {status:'BOUND'};}
      for(const b of Object.values(v[ROOT]))for(const other of Object.values(b.cells))if(other!==r&&other.state!=='RELEASED')need(!other.providerIds.some(id=>actual.includes(id)),'PROVIDER_ID_COLLISION');
      r.providerIds=actual;r.sourceHostBindingSha256=observation.sourceHostBindingSha256;r.state='BOUND';r.actualCostQualification='BOUND_PROVIDER_INVENTORY_RATE';return {status:'BOUND'};
    });
  }
  async function admitBatch(plan){
    const a=await approval(plan.id),bound=await authority.boundPlan(plan.id);
    need(hash(plan.sha256)&&plan.specSha256===plan.sha256&&bound?.planSha256===plan.sha256&&bound.intentSha256===a.intentSha256&&hash(bound.receiptSha256)&&bound.projectionSha256===batchDigest(plan),'BOUND_PLAN_AUTHORITY');
    need(equal(plan.payload,a.intent.payload)&&equal(plan.envelope,a.intent.envelope)&&plan.cells.length===a.intent.cells.length,'PLAN_PAYLOAD_OR_ENVELOPE');
    const observations=new Map();for(const c of plan.cells)observations.set(c.id,await custody.observe({batchId:plan.id,cellId:c.id}));
    return ledger.transaction(v=>{
      const s=state(v,a);need(s.status==='OPEN','BATCH_CANCELLED');const providerIds=[],guards=[];
      for(const c of plan.cells){
        const cell=a.intent.cells.find(x=>x.id===c.id),r=s.cells[c.id],b=bound.cells?.[c.id],o=observations.get(c.id);
        need(cell&&r?.state==='BOUND'&&equal(c.target,cell.target)&&c.namespace===cell.namespace&&c.nonce===cell.nonce&&equal(c.resources,cell.resources)&&c.expiresAt<=cell.cleanupAt&&hash(c.cellSha256)&&b?.cellSha256===c.cellSha256&&equal(ids(c.hosts),r.providerIds)&&equal(b.providerIds,r.providerIds)&&b.sourceHostBindingSha256===r.sourceHostBindingSha256,'BOUND_CELL_CHANGED');
        exactGuard(o.guard,r,cell);need(equal([...o.providerIds].sort(),r.providerIds)&&equal([...o.guard.providerIds].sort(),r.providerIds)&&o.sourceHostBindingVerified===true&&o.sourceHostBindingSha256===r.sourceHostBindingSha256,'SOURCE_HOST_BINDING_CHANGED');
        providerIds.push(...r.providerIds);guards.push(o.guard);r.cellSha256=c.cellSha256;
      }
      need(new Set(providerIds).size===providerIds.length,'PROVIDER_ID_COLLISION');s.planSha256=plan.sha256;
      return {status:'ADMITTED',planSha256:plan.sha256,cleanupGuard:{status:'ARMED',cleanupAt:Math.min(...guards.map(g=>g.cleanupAt)),authoritySha256:a.receiptSha256,providerIds:providerIds.sort()}};
    });
  }
  async function reserveCell(request){
    const a=await approval(request.batchId),cell=a.intent.cells.find(c=>c.id===request.cell?.id);need(cell,'UNAPPROVED_CELL');const o=await custody.observe({batchId:request.batchId,cellId:cell.id});
    need(Number.isFinite(request.cell.config?.lastNewPointAt)&&now()<request.cell.config.lastNewPointAt&&Number.isFinite(request.cell.config?.expiresAt)&&now()<request.cell.config.expiresAt,'CELL_DEADLINE');
    return ledger.transaction(v=>{
      const s=state(v,a),r=s.cells[cell.id];need(s.status==='OPEN'&&s.planSha256===request.planSha256&&r&&['BOUND','CLAIMED'].includes(r.state)&&r.cellSha256===batchDigest(request.cell),'CELL_CHANGED_OR_CANCELLED');exactGuard(o.guard,r,cell);need(equal([...o.providerIds].sort(),r.providerIds)&&o.sourceHostBindingVerified===true&&o.sourceHostBindingSha256===r.sourceHostBindingSha256,'SOURCE_HOST_BINDING_CHANGED');
      need(equal([...o.guard.providerIds].sort(),r.providerIds),'GUARD_PROVIDER_COVERAGE');r.state='CLAIMED';return {status:'RESERVED',token:r.token};
    });
  }
  async function releaseCell(request){
    // Releasing/cleaning after authority expiry is mandatory; use retained ledger
    // custody, not a renewed approval and never trust caller-declared deleted IDs.
    const record=await ledger.transaction(v=>clone(v[ROOT]?.[request.batchId]?.cells?.[request.cellId]));
    need(record&&record.token===request.token,'RELEASE_CUSTODY');
    if(record.state==='RELEASED')return {status:'RELEASED'};
    const absence=await custody.absence({batchId:request.batchId,cellId:request.cellId,record:clone(record)});
    const recovered=record.attempted&&record.providerIds.length===0&&absence?.recoveryVerified===true;
    need(absence?.namespace===record.namespace&&absence.nonce===record.nonce&&fresh(absence.observedAt)&&hash(absence.receiptSha256)&&absence.providerAbsent===true&&absence.providerKeyAbsent===true&&absence.localKeyFilesAbsent===true&&absence.guardSameBirthAbsent===true&&absence.guardGroupAbsent===true&&absence.guardPid===record.guard.pid&&absence.guardStartTicks===record.guard.startTicks&&Array.isArray(absence.providerIds)&&(recovered||equal([...absence.providerIds].sort(),record.providerIds)),'INDEPENDENT_ABSENCE_REQUIRED');
    need(equal([...request.providerIds].sort(),record.providerIds),'DELETION_IDS_CHANGED');
    return ledger.transaction(v=>{
      const s=v[ROOT]?.[request.batchId],r=s?.cells?.[request.cellId];need(r?.token===request.token&&equal(r.providerIds,record.providerIds),'RELEASE_CAS');if(r.state==='RELEASED')return {status:'RELEASED'};
      if(request.planSha256!==undefined)need(s.planSha256===request.planSha256,'RELEASE_PLAN_CHANGED');
      v.reservedAggregateHourlyUSD=usd(money(v.reservedAggregateHourlyUSD)-r.resources.hourlyMicrousd);
      if(r.actualHourlyCharged)v.currentAggregateHourlyUSD=usd(money(v.currentAggregateHourlyUSD)-r.resources.hourlyMicrousd);
      if(!r.attempted){v.totalReservedUpperUSD=usd(money(v.totalReservedUpperUSD)-r.resources.totalMicrousd);v.uncommittedUpperBudgetUSD=usd(money(v.uncommittedUpperBudgetUSD)+r.resources.totalMicrousd);}
      need(v.reservedAggregateHourlyUSD>=0&&v.currentAggregateHourlyUSD>=0,'LEDGER_UNDERFLOW');
      if(recovered)r.recoveredDeletedProviderIds=[...absence.providerIds].sort();r.state='RELEASED';r.absenceSha256=absence.receiptSha256;r.retainedUpperMicrousd=r.attempted?r.resources.totalMicrousd:0;return {status:'RELEASED'};
    });
  }
  async function cancelBatch(batchId){
    const records=await ledger.transaction(v=>{const s=v[ROOT]?.[batchId];need(s,'UNKNOWN_BATCH');s.status='CANCELLED';return Object.entries(s.cells).filter(([,r])=>r.state!=='RELEASED').map(([id,r])=>({id,...clone(r)}));});
    const results=await Promise.allSettled(records.map(async r=>{await cleanupOwned({batchId,cellId:r.id,record:clone(r)});return releaseCell({batchId,cellId:r.id,token:r.token,providerIds:r.providerIds});}));
    return {status:results.every(r=>r.status==='fulfilled')?'CANCELLED_CLEAN':'CANCELLED_CLEANUP_PENDING',cells:results.map((r,i)=>({id:records[i].id,status:r.status==='fulfilled'?'RELEASED':'UNCONFIRMED'}))};
  }
  const dispatch=(action,request)=>({'admit-batch':admitBatch,'reserve-cell':reserveCell,'release-cell':releaseCell}[action]??(()=>{throw Error('PGCAL_ROOT_UNKNOWN_ACTION');}))(request);
  return {dispatch,reserveBeforeAllocation,markCreateAttempt,bindAllocation,cancelBatch};
}
