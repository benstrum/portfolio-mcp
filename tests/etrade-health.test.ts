import {afterEach,expect,it,vi} from 'vitest';
import {isEasternPreflight,runEtradePreflight} from '../src/etrade-health';
import {connectedClient} from '../src/etrade-session';
import type {Env} from '../src/types';

const mockEnv=(token?:object)=>{
  const state=new Map<string,string>();
  if(token)state.set('etrade:access',JSON.stringify(token));
  const kv={
    get:async(key:string,mode?:string)=>{
      const value=state.get(key);
      return value===undefined?null:mode==='json'?JSON.parse(value):value;
    },
    put:async(key:string,value:string)=>{state.set(key,value);},
    delete:async(key:string)=>{state.delete(key);}
  } as unknown as KVNamespace;
  return {env:{STATE:kv,ETRADE_CONSUMER_KEY:'key',ETRADE_CONSUMER_SECRET:'secret'} as Env,state};
};
const preflightDate='2026-10-28T13:30:00Z';
afterEach(()=>vi.unstubAllGlobals());

it('matches 09:30 America/New_York across DST transitions only once',()=>{
  expect(isEasternPreflight(Date.parse('2026-10-14T13:30:00Z'))).toBe(true);
  expect(isEasternPreflight(Date.parse('2026-10-14T14:30:00Z'))).toBe(false);
  expect(isEasternPreflight(Date.parse('2026-11-14T14:30:00Z'))).toBe(true);
  expect(isEasternPreflight(Date.parse('2026-11-14T13:30:00Z'))).toBe(false);
});

it('records missing authorization without calling E*TRADE',async()=>{
  const {env,state}=mockEnv();
  const spy=vi.fn();
  vi.stubGlobal('fetch',spy);
  const result=await runEtradePreflight(env,Date.parse(preflightDate));
  expect(result?.result).toBe('authorization_required');
  expect(JSON.parse(state.get('etrade:lastHealth')!)).toMatchObject({
    result:'authorization_required'
  });
  expect(spy).not.toHaveBeenCalled();
});

it('renews an inactive intraday token and retries the account list',async()=>{
  const {env,state}=mockEnv({token:'test-token',secret:'test-secret',obtainedAt:Date.now()});
  let accountCalls=0;
  vi.stubGlobal('fetch',async(url:string)=>{
    if(url.includes('/v1/accounts/list')) {
      accountCalls++;
      return accountCalls===1?new Response('',{status:401}):
        Response.json({AccountListResponse:{Accounts:{Account:[{accountIdKey:'x',accountStatus:'ACTIVE'}]}}});
    }
    if(url.endsWith('/oauth/renew_access_token'))return new Response('Access Token has been renewed');
    throw Error('unexpected path');
  });
  const {accounts}=await connectedClient(env);
  expect(accounts).toHaveLength(1);
  expect(accountCalls).toBe(2);
  expect(state.has('etrade:access')).toBe(true);
});

it('keeps the token if E*TRADE is temporarily unavailable during renewal',async()=>{
  const {env,state}=mockEnv({token:'test-token',secret:'test-secret',obtainedAt:Date.now()});
  vi.stubGlobal('fetch',async(url:string)=>{
    if(url.includes('/v1/accounts/list'))return new Response('',{status:401});
    throw Error('network temporarily unavailable');
  });
  await expect(connectedClient(env)).rejects.toMatchObject({kind:'unavailable'});
  expect(state.has('etrade:access')).toBe(true);
});
