// Optional bounded cases inside existing Session transport; no provider or actor operations.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
const need=(v,c)=>{if(!v)throw Error('PGCAL_COMPONENT_'+c);};
const hash=c=>createHash('sha256').update('{'+Object.keys(c).sort().map(k=>JSON.stringify(k)+':'+JSON.stringify(c[k])).join(',')+'}').digest('hex');
export function componentCases(value,cohort){
 if(value===undefined)return null;
 need(Number.isInteger(cohort)&&cohort>=16&&cohort<=10000,'COHORT');
 need(value&&equal(Object.keys(value).sort(),['cases','version'])&&value.version===1&&Array.isArray(value.cases)&&value.cases.length>=1&&value.cases.length<=6,'PLAN');
 const ids=[];
 for(const c of value.cases){
  need(c&&equal(Object.keys(c).sort(),['id','kind','maxWrites','probeEveryMs','rate','sampleTenants','seconds','viewers'].sort())&&/^[a-z][a-z0-9-]{1,31}$/.test(c.id),'CASE');ids.push(c.id);
  need(['seconds','sampleTenants','viewers','probeEveryMs','maxWrites'].every(k=>Number.isInteger(c[k]))&&c.sampleTenants===16,'SAMPLE');
  if(c.kind==='rest')need(Number.isFinite(c.rate)&&c.rate>=1&&c.rate<=10000&&c.seconds===310&&c.viewers===2&&c.probeEveryMs===300000&&c.maxWrites===2,'REST');
  else if(c.kind==='evrt')need(c.rate===0&&c.seconds===32&&[1,2,4].includes(c.viewers)&&c.probeEveryMs===1000&&c.maxWrites===32,'EVRT');
  else need(false,'KIND');
 }
 need(new Set(ids).size===ids.length,'DUPLICATE');return value;
}
const payload=c=>({caseId:c.id,caseSha256:hash(c)});
const expect=(v,c,extra={})=>need(equal(v,{...payload(c),...extra}),'PHASE_BINDING');
export async function coordinateComponents(app,startGenerator,transfer,beforeCase,cases){
 await app.next('app-ready');const gen=await startGenerator();
 for(const c of cases){
  beforeCase(c);app.send('case-start',payload(c));gen.send('case-start',payload(c));
  const prime=await gen.next('client-primed',1800000);expect(prime,c,{primed:16*c.viewers});app.send('client-primed',prime);
  expect(await app.next('load-ready'),c);gen.send('load-start',payload(c));
  expect(await gen.next('load-complete',(c.seconds+600)*1000),c);app.send('load-complete',payload(c));
  const[server,client]=await Promise.all([app.next('server-recovery-complete',1000000),gen.next('client-complete',1500000)]);expect(server,c,{measurement:'NOT_RUN'});expect(client,c);
 }
 await transfer();app.send('finish');
 const result=await app.next('cell-complete',(cases.length*120+180)*1000);
 need(['PASS','PARTIAL'].includes(result.verdict)&&Array.isArray(result.cases)&&equal(result.cases.map(c=>c.id),cases.map(c=>c.id)),'RESULT');
 gen.send('finish');await Promise.all([app.finish(),gen.finish()]);return result;
}
