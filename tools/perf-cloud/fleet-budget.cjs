'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const MAX_HOURLY_USD=2;
function hourlyBudget(catalog,droplets,requested){
  if(!Array.isArray(catalog)||!Array.isArray(droplets)||!Array.isArray(requested))throw new Error('FLEET_INVENTORY_INVALID');
  const prices=new Map(catalog.map(row=>[row.slug,row.price_hourly]));
  const owned=droplets.filter(row=>row.name?.startsWith('nsperf-')||row.tags?.some(tag=>typeof tag==='string'&&tag.startsWith('nsperf-')));
  const price=slug=>{const value=prices.get(slug);if(!Number.isFinite(value)||value<=0)throw new Error('FLEET_PRICE_UNAVAILABLE');return value;};
  const existingHourlyUSD=owned.reduce((sum,row)=>sum+price(row.size_slug),0);
  const requestedHourlyUSD=requested.reduce((sum,row)=>sum+price(row.size),0);
  const combinedHourlyUSD=existingHourlyUSD+requestedHourlyUSD;
  if(combinedHourlyUSD>MAX_HOURLY_USD+1e-9)throw new Error('FLEET_HOURLY_LIMIT_EXCEEDED');
  return {limitHourlyUSD:MAX_HOURLY_USD,ownedDroplets:owned.length,existingHourlyUSD,requestedHourlyUSD,combinedHourlyUSD};
}
async function withFleetLock(callback,{directory=path.join(os.tmpdir(),'nsperf-fleet-'+process.getuid()+'.lock')}={}){
  try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw new Error('FLEET_PROVISIONING_BUSY');throw error;}
  try{
    await fs.writeFile(path.join(directory,'owner.json'),JSON.stringify({pid:process.pid,host:os.hostname(),startedAt:new Date().toISOString()}),{mode:0o600});
    return await callback();
  }finally{await fs.rm(directory,{recursive:true});}
}
module.exports={MAX_HOURLY_USD,hourlyBudget,withFleetLock};
