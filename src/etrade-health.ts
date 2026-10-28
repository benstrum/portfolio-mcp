import {connectedClient,easternDay} from './etrade-session';
import {EtradeError} from './etrade';
import type {Env} from './types';

export type Health={
  checkedAt:number;
  easternDay:string;
  result:'connected'|'authorization_required'|'unavailable';
  activeAccountCount?:number;
};

/** Cloudflare cron is UTC. Two trigger slots cover EDT and EST; only one matches 09:30 ET. */
export function isEasternPreflight(timestamp:number):boolean {
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date(timestamp));
  const value=(type:string)=>parts.find(p=>p.type===type)?.value;
  return value('hour')==='09' && value('minute')==='30';
}

export async function runEtradePreflight(env:Env,scheduledTime:number):Promise<Health|null> {
  if(!isEasternPreflight(scheduledTime))return null;
  const health:Health={
    checkedAt:Date.now(),easternDay:easternDay(scheduledTime),result:'unavailable'
  };
  try {
    const {accounts}=await connectedClient(env);
    health.result='connected';
    health.activeAccountCount=accounts.filter(a=>a.accountStatus==='ACTIVE').length;
  }catch(error) {
    health.result=error instanceof EtradeError&&error.kind==='authorization_required'
      ?'authorization_required':'unavailable';
  }
  await env.STATE.put('etrade:lastHealth',JSON.stringify(health),{expirationTtl:172800});
  // Optional notification endpoint: do not send any token, password, account ID, or holdings.
  const url=env.ETRADE_ALERT_WEBHOOK_URL;
  if(health.result!=='connected' && url) {
    const previous=await env.STATE.get<string>('etrade:lastAlert');
    if(previous!==health.easternDay) {
      try {
        const response=await fetch(url,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            event:'etrade_connection_attention_required',
            state:health.result,checkedAt:new Date(health.checkedAt).toISOString(),
            reconnectUrl:env.ETRADE_PUBLIC_BASE_URL
              ? env.ETRADE_PUBLIC_BASE_URL.replace(/\/$/,'')+'/etrade/connect' : undefined
          })
        });
        if(response.ok)await env.STATE.put('etrade:lastAlert',health.easternDay,{expirationTtl:172800});
        else console.warn('E*TRADE health alert delivery failed');
      }catch {console.warn('E*TRADE health alert delivery unavailable');}
    }
  }
  return health;
}
