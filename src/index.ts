import {currentToken,connectedClient} from './etrade-session';
import {etradeBrowserRoutes} from './etrade-browser';
import {runEtradePreflight} from './etrade-health';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {z} from 'zod';
import {EtradeClient,EtradeError,snapshot, type Token} from './etrade';
import type {Env} from './types';
const ttl=(s:string,f:number)=>Math.max(60,Math.min(Number(s)||f,2592000));
const random=()=>crypto.randomUUID()+crypto.randomUUID();
const safe=(a:string,b:string)=>{const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);let diff=x.length^y.length;for(let i=0;i<Math.max(x.length,y.length);i++)diff|=(x[i]??0)^(y[i]??0);return diff===0;};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"};
const json=(body:unknown,status=200,extra:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{...headers,...extra,'Content-Type':'application/json'}});
const html=(body:string,status=200,extra:Record<string,string>={})=>new Response(body,{status,headers:{...headers,...extra,'Content-Type':'text/html; charset=utf-8'}});
function authorizeCsp(redirect:string):string {
 const redirectOrigin=new URL(redirect).origin;
 return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'`;
}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const origin=(r:Request)=>new URL(r.url).origin;
const connect=(r:Request)=>`${origin(r)}/etrade/connect`;
async function token(env:Env){return currentToken(env);}
async function status(env:Env,r:Request){const t=await token(env);const lastPreflight=await env.STATE.get('etrade:lastHealth','json');return {connected:!!t,authorizationRequired:!t,reconnectUrl:!t?connect(r):undefined,authorizedAt:t?.obtainedAt,lastPreflight};}
async function client(env:Env,_r:Request){return (await connectedClient(env)).client;}
const toolNames=['get_connection_status','get_accounts','get_account_balances','get_positions','get_transactions','get_portfolio_snapshot',
 'get_quotes','get_option_quote','get_option_chain','get_option_expirations','get_vertical_spread_quote','get_orders','get_position_lots'] as const;
export {toolNames};
async function mcp(env:Env,req:Request){const server=new McpServer({name:'etrade-readonly-portfolio',version:'1.0.0'});
 const result=(v:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(v)}],structuredContent:v as Record<string,unknown>});
 const wrap=(fn:()=>Promise<unknown>)=>async()=>{try{return result(await fn());}catch(e){if(e instanceof EtradeError)return {content:[{type:'text' as const,text:JSON.stringify({error:e.kind,reconnectUrl:e.kind==='authorization_required'?connect(req):undefined})}],isError:true};return {content:[{type:'text' as const,text:'{"error":"internal"}'}],isError:true};}};
 const account=async(key:string)=>{const c=await client(env,req);const accounts=await c.accounts();if(!accounts.some(a=>a.accountIdKey===key))throw new EtradeError('upstream',404);return c;};
 server.registerTool('get_connection_status',{description:'Read-only E*TRADE connection status and reconnect URL.'},wrap(()=>status(env,req)));
 server.registerTool('get_accounts',{description:'Read-only list of all E*TRADE accounts.'},wrap(async()=>({accounts:await (await client(env,req)).accounts()})));
 server.registerTool('get_account_balances',{description:'Read-only balances for an E*TRADE account.',inputSchema:{accountIdKey:z.string().min(1)}},async({accountIdKey})=>wrap(async()=>({balance:await (await account(accountIdKey)).balance(accountIdKey)}))());
 server.registerTool('get_positions',{description:'Read-only positions for an E*TRADE account, including value and cost when supplied.',inputSchema:{accountIdKey:z.string().min(1)}},async({accountIdKey})=>wrap(async()=>({positions:await (await account(accountIdKey)).positions(accountIdKey)}))());
 server.registerTool('get_transactions',{description:'Read-only transactions for an E*TRADE account. Dates use MMDDYYYY.',inputSchema:{accountIdKey:z.string().min(1),startDate:z.string().regex(/^\d{8}$/).optional(),endDate:z.string().regex(/^\d{8}$/).optional(),marker:z.string().optional()}},async({accountIdKey,startDate,endDate,marker})=>wrap(async()=>await (await account(accountIdKey)).transactions(accountIdKey,startDate,endDate,marker))());
 const ticker=z.string().regex(/^[A-Za-z][A-Za-z0-9.-]{0,12}$/,'Expected a stock ticker');
 const exp=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const x=new Date(s+'T00:00:00Z');return !Number.isNaN(x.getTime())&&x.toISOString().slice(0,10)===s;},'Invalid expiration date');
 const strike=z.number().finite().positive().max(100000);
 const cp=z.enum(['CALL','PUT']);
 server.registerTool('get_quotes',{
   description:'Read-only E*TRADE stock/ETF bid/ask quotes (1-25 tickers). Returns provider REALTIME/DELAYED status and timestamps; do not assume executable real-time pricing.',
   inputSchema:{symbols:z.array(ticker).min(1).max(25)}
 },async({symbols})=>wrap(async()=>await (await client(env,req)).quotes(symbols.map(x=>x.toUpperCase())))());
 server.registerTool('get_option_quote',{
   description:'Read-only quote for one exact option contract, including bid/ask, sizes, provider timestamp, quote status, and option Greeks where available.',
   inputSchema:{underlying:ticker,expiration:exp,optionType:cp,strikePrice:strike}
 },async({underlying,expiration,optionType,strikePrice})=>wrap(async()=>await (await client(env,req)).optionQuote(underlying.toUpperCase(),expiration,optionType,strikePrice))());
 server.registerTool('get_option_chain',{
   description:'Read-only option chain for a specified expiration; returns exact call/put strike, bid/ask, size, open interest and quote timestamps.',
   inputSchema:{underlying:ticker,expiration:exp,optionType:z.enum(['CALL','PUT','BOTH']).default('BOTH'),
     strikePriceNear:strike.optional(),noOfStrikes:z.number().int().min(1).max(40).default(20)}
 },async({underlying,expiration,optionType,strikePriceNear,noOfStrikes})=>wrap(async()=>await (await client(env,req)).optionChain(underlying.toUpperCase(),expiration,optionType,strikePriceNear,noOfStrikes))());
 server.registerTool('get_option_expirations',{
   description:'Read-only list of available E*TRADE option expiration dates for a symbol.',
   inputSchema:{underlying:ticker}
 },async({underlying})=>wrap(async()=>await (await client(env,req)).optionExpirations(underlying.toUpperCase()))());
 server.registerTool('get_vertical_spread_quote',{
   description:'Read-only INDICATIVE two-leg vertical quote for a long and short option at the same expiration. Derives opening debit ask = long ask minus short bid; closing credit bid = long bid minus short ask. NOT an executable combination-market quote. Verify E*TRADE combo market.',
   inputSchema:{underlying:ticker,expiration:exp,optionType:cp,longStrike:strike,shortStrike:strike}
 },async({underlying,expiration,optionType,longStrike,shortStrike})=>wrap(async()=>{
   if(longStrike===shortStrike)throw new EtradeError('upstream',400);
   const symbol=underlying.toUpperCase(),c=await client(env,req);
   const [long,short]=await Promise.all([
     c.optionQuote(symbol,expiration,optionType,longStrike),
     c.optionQuote(symbol,expiration,optionType,shortStrike)
   ]);
   if('unavailable' in (long.quote??{})||'unavailable' in (short.quote??{}))
     return {error:'missing_option_quote',longQuote:long.quote,shortQuote:short.quote,warning:'No spread price calculated from missing leg markets'};
   const {verticalPrice}=await import('./read-models');
   return verticalPrice(symbol,expiration,optionType,longStrike,shortStrike,
     long.quote as Parameters<typeof verticalPrice>[5],short.quote as Parameters<typeof verticalPrice>[6]);
 })());
 server.registerTool('get_orders',{
   description:'Read-only list of open or historical E*TRADE order statuses and multi-leg details for one account. This tool cannot place, change or cancel orders.',
   inputSchema:{accountIdKey:z.string().min(1),
     status:z.enum(['OPEN','EXECUTED','CANCELLED','INDIVIDUAL_FILLS','CANCEL_REQUESTED','EXPIRED','REJECTED']).default('OPEN'),
     fromDate:z.string().regex(/^\d{8}$/).optional(),toDate:z.string().regex(/^\d{8}$/).optional(),
     count:z.number().int().min(1).max(100).default(50),marker:z.string().max(512).optional()}
 },async({accountIdKey,status,fromDate,toDate,count,marker})=>wrap(async()=>{
   if(!!fromDate!==!!toDate)throw new EtradeError('upstream',400);
   return (await account(accountIdKey)).orders(accountIdKey,status,marker,fromDate,toDate,count);
 })());
 server.registerTool('get_position_lots',{
   description:'Read-only E*TRADE holdings and acquisition-level tax lots for one account, if supported. Missing lots must not be interpreted as zero cost basis.',
   inputSchema:{accountIdKey:z.string().min(1)}
 },async({accountIdKey})=>wrap(async()=>await (await account(accountIdKey)).positionLots(accountIdKey))());
 server.registerTool('get_portfolio_snapshot',{
   description:'Read-only consolidated ACTIVE E*TRADE accounts; partial data when an account endpoint fails. Money-market funds are positions, not cash. No closed accounts included.'
 },wrap(async()=>{
   const c=await client(env,req),all=await c.accounts(),accounts=all.filter(a=>a.accountStatus==='ACTIVE');
   const retrieved=await Promise.all(accounts.map(async a=>{
     const [balance,positions]=await Promise.allSettled([c.balance(a.accountIdKey),c.positions(a.accountIdKey)]);
     return {account:a,balance,positions};
   }));
   const valid=retrieved.filter(x=>x.balance.status==='fulfilled'&&x.positions.status==='fulfilled');
   const errors=retrieved.filter(x=>x.balance.status!=='fulfilled'||x.positions.status!=='fulfilled').map(x=>({
     accountName:x.account.accountName,accountNumberMasked:x.account.accountNumberMasked,
     balanceAvailable:x.balance.status==='fulfilled',positionsAvailable:x.positions.status==='fulfilled'
   }));
   const summary=snapshot(valid.map(x=>x.account),
     valid.map(x=>(x.balance as PromiseFulfilledResult<any>).value),
     valid.map(x=>(x.positions as PromiseFulfilledResult<any>).value));
   return {...summary,partial:errors.length>0,unavailableAccounts:errors,
     activeAccountCount:accounts.length,includedAccountCount:valid.length,
     excludedClosedAccountCount:all.length-accounts.length,receivedAt:new Date().toISOString(),
     note:'Position values include money-market funds. Account total is indicative if broker totalAccountValue or margin liabilities are unavailable. Do not interpret unrealized P/L as total period return.'};
 }));
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined});await server.connect(transport);return transport.handleRequest(req);
}
async function hash(s:string){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');}
async function authorizeMcp(req:Request,env:Env){const value=req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];if(!value)return false;return !!await env.STATE.get(`mcp:access:${await hash(value)}`);}
const form=async(r:Request)=>new URLSearchParams(await r.text());
function metadata(r:Request){const o=origin(r);return {issuer:o,authorization_endpoint:o+'/authorize',token_endpoint:o+'/token',registration_endpoint:o+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:['portfolio.read']};}
async function oauthRoutes(r:Request,e:Env,u:URL):Promise<Response|undefined>{
 if(u.pathname==='/.well-known/oauth-authorization-server'||u.pathname==='/.well-known/oauth-authorization-server/mcp')return json(metadata(r));
 if(u.pathname==='/.well-known/oauth-protected-resource'||u.pathname==='/.well-known/oauth-protected-resource/mcp')return json({resource:origin(r)+'/mcp',authorization_servers:[origin(r)],scopes_supported:['portfolio.read']});
 if(u.pathname==='/register'&&r.method==='POST'){const b=await r.json() as any;const redirects=b.redirect_uris;if(!Array.isArray(redirects)||redirects.length===0||redirects.some((v:unknown)=>typeof v!=='string'||!/^https:\/\//.test(v)))return json({error:'invalid_redirect_uri'},400);const id=random();await e.STATE.put(`mcp:client:${id}`,JSON.stringify({redirects}),{expirationTtl:2592000});return json({client_id:id,redirect_uris:redirects,token_endpoint_auth_method:'none'});}
 if(u.pathname==='/authorize'&&(r.method==='GET'||r.method==='POST')){const p=u.searchParams;if(r.method==='POST'){const submitted=await form(r);for(const [key,value] of submitted)p.set(key,value);}const id=p.get('client_id')??'',redirect=p.get('redirect_uri')??'',challenge=p.get('code_challenge')??'',state=p.get('state')??'';const saved=await e.STATE.get<{redirects:string[]}>(`mcp:client:${id}`,'json');if(!saved?.redirects.includes(redirect)||p.get('response_type')!=='code'||p.get('code_challenge_method')!=='S256'||!challenge||!state)return json({error:'invalid_request'},400);if(r.method==='GET'){const action=esc('/authorize?'+u.searchParams.toString());return html(`<h1>Authorize read-only portfolio access</h1><form method="post" action="${action}"><label>Admin password <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Authorize</button></form>`,200,{'Content-Security-Policy':authorizeCsp(redirect)});}if(!safe(p.get('password')??'',e.MCP_ADMIN_PASSWORD))return html('<p>Invalid password</p>',401);const code=random();await e.STATE.put(`mcp:code:${await hash(code)}`,JSON.stringify({id,redirect,challenge}),{expirationTtl:300});const dest=new URL(redirect);dest.searchParams.set('code',code);dest.searchParams.set('state',state);return new Response(null,{status:302,headers:{...headers,'Content-Security-Policy':authorizeCsp(redirect),Location:dest.toString()}});}
 if(u.pathname==='/token'&&r.method==='POST'){const p=await form(r),grant=p.get('grant_type'),id=p.get('client_id')??'';if(grant==='authorization_code'){const code=p.get('code')??'',saved=await e.STATE.get<{id:string;redirect:string;challenge:string}>(`mcp:code:${await hash(code)}`,'json');if(!saved||saved.id!==id||saved.redirect!==p.get('redirect_uri')||!safe(saved.challenge,await hashBase64(p.get('code_verifier')??'')))return json({error:'invalid_grant'},400);await e.STATE.delete(`mcp:code:${await hash(code)}`);return issue(e,id);}if(grant==='refresh_token'){const refresh=p.get('refresh_token')??'',key=`mcp:refresh:${await hash(refresh)}`,saved=await e.STATE.get<{id:string}>(key,'json');if(!saved||saved.id!==id)return json({error:'invalid_grant'},400);await e.STATE.delete(key);return issue(e,id);}return json({error:'unsupported_grant_type'},400);}
}
async function hashBase64(s:string){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
async function issue(e:Env,id:string){const access=random(),refresh=random(),at=ttl(e.MCP_ACCESS_TOKEN_TTL_SECONDS,3600),rt=ttl(e.MCP_REFRESH_TOKEN_TTL_SECONDS,2592000);await Promise.all([e.STATE.put(`mcp:access:${await hash(access)}`,id,{expirationTtl:at}),e.STATE.put(`mcp:refresh:${await hash(refresh)}`,JSON.stringify({id}),{expirationTtl:rt})]);return json({access_token:access,token_type:'Bearer',expires_in:at,refresh_token:refresh,scope:'portfolio.read'});}
export default {async scheduled(event:ScheduledController,e:Env):Promise<void>{await runEtradePreflight(e,event.scheduledTime);},async fetch(r:Request,e:Env):Promise<Response>{const u=new URL(r.url);try{if(u.pathname==='/health')return json({ok:true});const browser=await etradeBrowserRoutes(r,e,u);if(browser)return browser;const oauth=await oauthRoutes(r,e,u);if(oauth)return oauth;
 if(u.pathname==='/mcp'){if(!await authorizeMcp(r,e))return json({error:'unauthorized'},401,{'WWW-Authenticate':`Bearer resource_metadata="${origin(r)}/.well-known/oauth-protected-resource/mcp"`});if(r.method!=='GET'&&r.method!=='POST')return json({error:'method_not_allowed'},405);return mcp(e,r);}
 const admin=safe(r.headers.get('x-admin-password')??'',e.MCP_ADMIN_PASSWORD);if(u.pathname==='/etrade/status'){if(!admin)return json({error:'unauthorized'},401);return json(await status(e,r));}
 if(u.pathname==='/etrade/auth/start'&&(r.method==='GET'||r.method==='POST')){if(!admin)return json({error:'unauthorized'},401);const t=await new EtradeClient(e.ETRADE_CONSUMER_KEY,e.ETRADE_CONSUMER_SECRET).requestToken(),state=random();await e.STATE.put(`etrade:pending:${await hash(state)}`,JSON.stringify(t),{expirationTtl:300});const url=new URL('https://us.etrade.com/e/t/etws/authorize');url.searchParams.set('key',e.ETRADE_CONSUMER_KEY);url.searchParams.set('token',t.token);return json({authorizeUrl:url.toString(),verifierUrl:`${origin(r)}/etrade/complete?state=${encodeURIComponent(state)}`});}
 if(u.pathname==='/etrade/complete'&&(r.method==='GET'||r.method==='POST')){const state=u.searchParams.get('state')??'',pending=await e.STATE.get<{token:string;secret:string}>(`etrade:pending:${await hash(state)}`,'json');if(!pending)return json({error:'invalid_or_expired_state'},400);if(r.method==='GET')return html(`<h1>Complete E*TRADE authorization</h1><form method="post" action="/etrade/complete?state=${esc(state)}"><label>Verifier code <input name="verifier" autocomplete="off" required></label><button type="submit">Connect</button></form>`);const p=await form(r),verifier=p.get('verifier')??'';if(!/^[A-Za-z0-9]{4,32}$/.test(verifier))return json({error:'invalid_verifier'},400);const access=await new EtradeClient(e.ETRADE_CONSUMER_KEY,e.ETRADE_CONSUMER_SECRET).accessToken(pending,verifier);await e.STATE.put('etrade:access',JSON.stringify(access));await e.STATE.delete(`etrade:pending:${await hash(state)}`);return html('<p>E*TRADE connected. You can close this page.</p>');}
 return json({error:'not_found'},404);}catch(err){if(err instanceof EtradeError)return json({error:err.kind,reconnectUrl:err.kind==='authorization_required'?connect(r):undefined,diagnostic:u.pathname==='/etrade/auth/start'&&safe(r.headers.get('x-admin-password')??'',e.MCP_ADMIN_PASSWORD)?err.diagnostic:undefined},err.status===401?401:502);return json({error:'internal'},500);}}};
