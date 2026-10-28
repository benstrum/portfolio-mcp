import {afterEach,expect,it,vi} from 'vitest';
import worker from '../src/index';
import type {Env} from '../src/types';

function memoryEnv() {
  const state=new Map<string,string>();
  const kv={
    get:async(key:string,format?:string)=>{
      const value=state.get(key);
      return value===undefined?null:format==='json'?JSON.parse(value):value;
    },
    put:async(key:string,value:string)=>{state.set(key,value);},
    delete:async(key:string)=>{state.delete(key);}
  } as unknown as KVNamespace;
  return {env:{
    STATE:kv,MCP_ADMIN_PASSWORD:'admin-only-password',
    ETRADE_CONSUMER_KEY:'consumer',ETRADE_CONSUMER_SECRET:'secret'
  } as Env,state};
}
const base='https://portfolio-mcp.example';
afterEach(()=>vi.unstubAllGlobals());

it('offers a browser login without exposing an admin-header-only URL',async()=>{
  const {env}=memoryEnv();
  const res=await worker.fetch(new Request(base+'/etrade/connect'),env);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('name="password"');
  expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
  expect(res.headers.get('Cache-Control')).toBe('no-store');
});

it('rejects a bad password without requesting an E*TRADE token',async()=>{
  const {env}=memoryEnv();
  const fetchMock=vi.fn();
  vi.stubGlobal('fetch',fetchMock);
  const res=await worker.fetch(new Request(base+'/etrade/connect',{
    method:'POST',body:new URLSearchParams({password:'wrong'})
  }),env);
  expect(res.status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('finishes a registered E*TRADE callback only for its initiating browser session',async()=>{
  const {env,state}=memoryEnv();
  vi.stubGlobal('fetch',async(url:string)=>{
    if(url.endsWith('/oauth/request_token'))
      return new Response('oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true');
    if(url.endsWith('/oauth/access_token'))
      return new Response('oauth_token=access-token&oauth_token_secret=access-secret');
    throw Error('unexpected E*TRADE URL: '+new URL(url).pathname);
  });
  const started=await worker.fetch(new Request(base+'/etrade/connect',{
    method:'POST',body:new URLSearchParams({password:'admin-only-password'})
  }),env);
  expect(started.status).toBe(303);
  expect(started.headers.get('Location')).toContain('us.etrade.com');
  const cookie=started.headers.get('Set-Cookie')!;
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  const header=cookie.split(';')[0];

  const unsolicited=await worker.fetch(new Request(base+'/etrade/callback?oauth_verifier=ABCD12'),env);
  expect(unsolicited.status).toBe(400);
  const forged=await worker.fetch(new Request(base+'/etrade/callback?oauth_verifier=ABCD12&oauth_token=wrong',{
    headers:{Cookie:header}
  }),env);
  expect(forged.status).toBe(400);
  expect(state.has('etrade:access')).toBe(false);

  const callback=await worker.fetch(new Request(base+'/etrade/callback?oauth_verifier=ABCD12&oauth_token=request-token',{
    headers:{Cookie:header}
  }),env);
  expect(callback.status).toBe(200);
  expect(callback.headers.get('Set-Cookie')).toContain('Max-Age=0');
  expect(JSON.parse(state.get('etrade:access')!)).toMatchObject({
    token:'access-token',secret:'access-secret'
  });
  const replay=await worker.fetch(new Request(base+'/etrade/callback?oauth_verifier=ABCD12',{
    headers:{Cookie:header}
  }),env);
  expect(replay.status).toBe(400);
});

it('falls back to manual verifier within the browser if E*TRADE has no registered callback',async()=>{
  const {env,state}=memoryEnv();
  vi.stubGlobal('fetch',async(url:string)=>{
    if(url.endsWith('/oauth/request_token'))
      return new Response('oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=false');
    if(url.endsWith('/oauth/access_token'))
      return new Response('oauth_token=access-token&oauth_token_secret=access-secret');
    throw Error('unexpected URL');
  });
  const page=await worker.fetch(new Request(base+'/etrade/connect',{
    method:'POST',body:new URLSearchParams({password:'admin-only-password'})
  }),env);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('action="/etrade/browser/finish"');
  const completed=await worker.fetch(new Request(base+'/etrade/browser/finish',{
    method:'POST',headers:{Cookie:page.headers.get('Set-Cookie')!.split(';')[0]},
    body:new URLSearchParams({verifier:'ABCD123'})
  }),env);
  expect(completed.status).toBe(200);
  expect(state.has('etrade:access')).toBe(true);
});
