import {afterEach,expect,it,vi} from 'vitest';
import worker from '../src/index';
import type {Env} from '../src/types';
import {issueReconnectUrl,verifyTicketFromLink,RECONNECT_COOKIE_NAME} from '../src/reconnect-ticket';

const origin='https://portfolio-mcp.example';
const memoryEnv=()=>{
  const state=new Map<string,string>();
  const kv={
    get:async(key:string,format?:string)=>{
      const value=state.get(key);
      return value===undefined?null:format==='json'?JSON.parse(value):value;
    },
    put:async(key:string,value:string)=>{state.set(key,value);},
    delete:async(key:string)=>{state.delete(key);}
  } as unknown as KVNamespace;
  return {env:{STATE:kv,MCP_ADMIN_PASSWORD:'private-admin-password',
    ETRADE_CONSUMER_KEY:'consumer',ETRADE_CONSUMER_SECRET:'consumer-secret'} as Env,state};
};
afterEach(()=>vi.unstubAllGlobals());

function mockRequestToken() {
  const calls=vi.fn(async (url:string)=>{
    if(url.endsWith('/oauth/request_token'))
      return new Response('oauth_token=request-value&oauth_token_secret=request-secret&oauth_callback_confirmed=false');
    throw new Error('Unexpected upstream request');
  });
  vi.stubGlobal('fetch',calls);
  return calls;
}

it('issues high-entropy reconnect URLs and stores no raw bearer token in KV',async()=>{
  const {env,state}=memoryEnv();
  const url=await issueReconnectUrl(env,new Request(origin+'/mcp'));
  const link=new URL(url);
  expect(link.origin).toBe(origin);
  expect(link.pathname).toBe('/etrade/connect');
  const secret=link.searchParams.get('ticket')!;
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(await verifyTicketFromLink(env,secret)).toBe(true);
  expect(state.has('etrade:reconnect-ticket:'+secret)).toBe(false);
});

it('rejects arbitrary links without enabling an unauthenticated bypass',async()=>{
  const {env}=memoryEnv();
  const res=await worker.fetch(new Request(origin+'/etrade/connect?ticket='+'a'.repeat(64)),env);
  expect(res.status).toBe(403);
  expect((await res.text())).toContain('invalid or has expired');
  const normal=await worker.fetch(new Request(origin+'/etrade/connect'),env);
  expect(await normal.text()).toContain('name="password"');
});

it('reconnects without a password when holding a valid MCP-issued ticket',async()=>{
  const {env,state}=memoryEnv();
  const url=await issueReconnectUrl(env,new Request(origin+'/mcp'));
  const first=await worker.fetch(new Request(url),env);
  expect(first.status).toBe(303);
  expect(first.headers.get('Location')).toBe('/etrade/connect');
  expect(first.headers.get('Referrer-Policy')).toBe('no-referrer');
  const cookie=first.headers.get('Set-Cookie')!;
  expect(cookie).toContain(RECONNECT_COOKIE_NAME+'=');
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');
  const cookieHeader=cookie.split(';')[0];

  const page=await worker.fetch(new Request(origin+'/etrade/connect',{
    headers:{Cookie:cookieHeader}
  }),env);
  const html=await page.text();
  expect(page.status).toBe(200);
  expect(html).toContain('Continue to E*TRADE');
  expect(html).not.toContain('name="password"');

  const fetchMock=mockRequestToken();
  const result=await worker.fetch(new Request(origin+'/etrade/connect',{
    method:'POST',headers:{Cookie:cookieHeader,Origin:origin},
    body:new URLSearchParams()
  }),env);
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('action="/etrade/browser/finish"');
  expect(result.headers.get('Set-Cookie')).toContain('Max-Age=0');
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // The original ticket cannot authorize another exchange.
  const replay=await worker.fetch(new Request(origin+'/etrade/connect',{
    method:'POST',headers:{Cookie:cookieHeader,Origin:origin},
    body:new URLSearchParams()
  }),env);
  expect(replay.status).toBe(401);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect([...state.keys()].filter(k=>k.startsWith('etrade:browser:'))).toHaveLength(1);
});

it('refuses a cross-origin POST despite a valid reconnect cookie',async()=>{
  const {env}=memoryEnv();
  const url=await issueReconnectUrl(env,new Request(origin+'/mcp'));
  const first=await worker.fetch(new Request(url),env);
  const cookie=first.headers.get('Set-Cookie')!.split(';')[0];
  const upstream=mockRequestToken();
  const forbidden=await worker.fetch(new Request(origin+'/etrade/connect',{
    method:'POST',headers:{Cookie:cookie,Origin:'https://evil.example'},
    body:new URLSearchParams()
  }),env);
  expect(forbidden.status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
  // A legitimate same-origin POST can still redeem the unconsumed link.
  const allowed=await worker.fetch(new Request(origin+'/etrade/connect',{
    method:'POST',headers:{Cookie:cookie,Origin:origin},
    body:new URLSearchParams()
  }),env);
  expect(allowed.status).toBe(200);
});

it('expires the ticket independently of E*TRADE OAuth and requires a fresh link',async()=>{
  const {env,state}=memoryEnv();
  const url=await issueReconnectUrl(env,new Request(origin+'/mcp'));
  const link=new URL(url);
  const ticket=link.searchParams.get('ticket')!;
  for(const key of state.keys()){
    if(key.startsWith('etrade:reconnect-ticket:')) {
      const raw=JSON.parse(state.get(key)!);
      raw.issuedAt=Date.now()-301000;
      state.set(key,JSON.stringify(raw));
    }
  }
  expect(await verifyTicketFromLink(env,ticket)).toBe(false);
  const result=await worker.fetch(new Request(url),env);
  expect(result.status).toBe(403);
});
