import {EtradeClient, EtradeError, type Token} from './etrade';
import type {Env} from './types';

/** E*TRADE production access tokens expire at midnight in New York. */
export function easternDay(time:number):string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'
  }).format(new Date(time));
}

export async function currentToken(env:Env):Promise<Token|null> {
  const t=await env.STATE.get<Token>('etrade:access','json');
  return t && easternDay(t.obtainedAt)===easternDay(Date.now()) ? t : null;
}

/** Probe access, reactivate an INACTIVE token, and never treat a transient outage as a revoked token. */
export async function connectedClient(env:Env):Promise<{client:EtradeClient;accounts:any[]}> {
  const t=await currentToken(env);
  if(!t) throw new EtradeError('authorization_required',401);
  const c=new EtradeClient(env.ETRADE_CONSUMER_KEY,env.ETRADE_CONSUMER_SECRET,t);
  try {
    return {client:c,accounts:await c.accounts()};
  } catch (error) {
    if(!(error instanceof EtradeError) || error.kind!=='authorization_required') throw error;
  }
  try {
    await c.renew();
    return {client:c,accounts:await c.accounts()};
  } catch(error) {
    if(error instanceof EtradeError && error.kind==='authorization_required') {
      await env.STATE.delete('etrade:access');
      throw new EtradeError('authorization_required',401);
    }
    throw error;
  }
}
