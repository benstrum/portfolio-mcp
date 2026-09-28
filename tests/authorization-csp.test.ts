import {expect,it} from 'vitest';
import worker from '../src/index';
import type {Env} from '../src/types';

it('permits only the registered OAuth redirect origin for form completion',async()=>{
 const redirect='https://chatgpt.com/connector/oauth/test';
 const client='test-client';
 const state=new Map<string,string>([[`mcp:client:${client}`,JSON.stringify({redirects:[redirect]})]]);
 const kv={
   get:async(key:string)=>{const value=state.get(key);return value?JSON.parse(value):null;},
   put:async(key:string,value:string)=>{state.set(key,value);},
   delete:async(key:string)=>{state.delete(key);}
 } as unknown as KVNamespace;
 const env={STATE:kv,MCP_ADMIN_PASSWORD:'private-password'} as Env;
 const url=new URL('https://portfolio.example/authorize');
 Object.entries({response_type:'code',client_id:client,redirect_uri:redirect,code_challenge:'challenge',code_challenge_method:'S256',state:'opaque-state'}).forEach(([k,v])=>url.searchParams.set(k,v));
 const page=await worker.fetch(new Request(url),env);
 expect(page.status).toBe(200);
 expect(page.headers.get('Content-Security-Policy')).toContain("form-action 'self' https://chatgpt.com;");
 expect(page.headers.get('Content-Security-Policy')).not.toContain('https://elsewhere.example');
 const submit=await worker.fetch(new Request(url,{method:'POST',body:new URLSearchParams({password:'private-password'})}),env);
 expect(submit.status).toBe(302);
 expect(submit.headers.get('Location')).toMatch(/^https:\/\/chatgpt\.com\/connector\/oauth\/test\?code=/);
 expect(submit.headers.get('Content-Security-Policy')).toContain('https://chatgpt.com');
});
