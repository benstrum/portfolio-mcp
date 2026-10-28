import {EtradeClient, EtradeError} from './etrade';
import type {Env} from './types';

const cookieName='portfolio_etrade_state';
const commonHeaders={
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
};
const html=(s:string,status=200,extra:Record<string,string>={})=>
  new Response(s,{status,headers:{...commonHeaders,...extra,'Content-Type':'text/html; charset=utf-8'}});
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const random=()=>crypto.randomUUID()+crypto.randomUUID();
async function sha(s:string) {
  const data=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  return Array.from(data,x=>x.toString(16).padStart(2,'0')).join('');
}
function constantEqual(a:string,b:string) {
  const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);
  let diff=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]??0)^(y[i]??0);
  return diff===0;
}
const cookie=(state:string,maxAge:number)=>cookieName+'='+state+'; Path=/etrade; Secure; HttpOnly; SameSite=Lax; Max-Age='+maxAge;
const session=(r:Request)=>r.headers.get('cookie')?.match(/(?:^|;\s*)portfolio_etrade_state=([^;]+)/)?.[1]??'';
const key=async(state:string)=>'etrade:browser:'+await sha(state);
const message=(text:string,status=400)=>html('<h1>E*TRADE connection</h1><p>'+esc(text)+'</p><p><a href="/etrade/connect">Start over</a></p>',status);
function authorizeUrl(consumerKey:string,requestToken:string):string {
  const url=new URL('https://us.etrade.com/e/t/etws/authorize');
  url.searchParams.set('key',consumerKey);
  url.searchParams.set('token',requestToken);
  return url.toString();
}
function manualPage(authorize:string):Response {
  return html(
    '<h1>Authorize E*TRADE</h1><p>E*TRADE has not confirmed a registered OAuth callback.</p>'+
    '<p><a href="'+esc(authorize)+'" target="_blank" rel="noopener noreferrer">Open E*TRADE to approve access</a></p>'+
    '<p>After approval, paste the verification code below (no PowerShell required).</p>'+
    '<form method="post" action="/etrade/browser/finish">'+
    '<label>Verification code <input name="verifier" autocomplete="off" required maxlength="32"></label>'+
    '<button type="submit">Connect</button></form>'
  );
}
type Pending={token:string;secret:string;createdAt:number};
async function complete(r:Request,env:Env,u:URL,callback:boolean):Promise<Response> {
  // Cookies with SameSite=Lax accompany top-level GET redirects from E*TRADE.
  const state=session(r);
  if(!/^[a-f0-9-]{72}$/.test(state))return message('Your authorization session is missing or expired.');
  const pending=await env.STATE.get<Pending>(await key(state),'json');
  if(!pending || Date.now()-pending.createdAt>300000)return message('Your authorization session has expired.');
  const verifier=callback ? u.searchParams.get('oauth_verifier')??'' :
    new URLSearchParams(await r.text()).get('verifier')??'';
  if(!/^[A-Za-z0-9]{4,32}$/.test(verifier))return message('Invalid verification code.');
  const replyToken=u.searchParams.get('oauth_token');
  if(callback && replyToken && replyToken!==pending.token)return message('Authorization token mismatch.');
  const access=await new EtradeClient(env.ETRADE_CONSUMER_KEY,env.ETRADE_CONSUMER_SECRET)
    .accessToken({token:pending.token,secret:pending.secret},verifier);
  await env.STATE.put('etrade:access',JSON.stringify(access));
  await env.STATE.delete(await key(state));
  return html('<h1>E*TRADE connected</h1><p>Authorization completed. You can close this page.</p>',
    200,{'Set-Cookie':cookie('',0)});
}

/** Browser-friendly entry point. The legacy admin-header endpoints remain available. */
export async function etradeBrowserRoutes(r:Request,env:Env,u:URL):Promise<Response|undefined> {
  if(u.pathname==='/etrade/connect'&&r.method==='GET') {
    return html('<h1>Reconnect E*TRADE</h1><p>Use your Portfolio MCP admin password, not your brokerage password.</p>'+
      '<form method="post" action="/etrade/connect">'+
      '<label>Portfolio MCP admin password <input type="password" name="password" autocomplete="current-password" required></label>'+
      '<button type="submit">Continue to E*TRADE</button></form>');
  }
  if(u.pathname==='/etrade/connect'&&r.method==='POST') {
    if(Number(r.headers.get('content-length')??0)>4096)return message('Invalid request.');
    const p=new URLSearchParams(await r.text());
    if(!constantEqual(p.get('password')??'',env.MCP_ADMIN_PASSWORD))return message('Invalid authorization.',401);
    const requested=await new EtradeClient(env.ETRADE_CONSUMER_KEY,env.ETRADE_CONSUMER_SECRET).requestToken();
    const state=random();
    await env.STATE.put(await key(state),JSON.stringify({
      token:requested.token, secret:requested.secret, createdAt:Date.now()
    } satisfies Pending),{expirationTtl:300});
    const url=authorizeUrl(env.ETRADE_CONSUMER_KEY,requested.token);
    if(!requested.callbackConfirmed) {
      const response=manualPage(url);
      response.headers.set('Set-Cookie',cookie(state,300));
      return response;
    }
    return new Response(null,{status:303,headers:{
      ...commonHeaders,Location:url,'Set-Cookie':cookie(state,300)
    }});
  }
  if(u.pathname==='/etrade/callback'&&r.method==='GET')
    return complete(r,env,u,true);
  if(u.pathname==='/etrade/browser/finish'&&r.method==='POST')
    return complete(r,env,u,false);
  return undefined;
}
