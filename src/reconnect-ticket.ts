import type {Env} from './types';

/**
 * A reconnect link is issued ONLY after an MCP bearer token has been authenticated.
 * It is a five-minute bearer capability for starting E*TRADE OAuth, not for reading accounts.
 */
export const RECONNECT_TTL_SECONDS = 300;
export const RECONNECT_COOKIE_NAME = 'portfolio_reconnect_ticket';

const hex = (bytes:Uint8Array) => Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
const validShape = (ticket:string) => /^[0-9a-f]{64}$/.test(ticket);
const digest = async(s:string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));
const ticketKey = async(ticket:string) => 'etrade:reconnect-ticket:'+await digest(ticket);

function browserTicket(req:Request):string {
  const cookies=req.headers.get('cookie')??'';
  const token=cookies.split(';').map(x=>x.trim()).find(x=>x.startsWith(RECONNECT_COOKIE_NAME+'='));
  return token?.slice(RECONNECT_COOKIE_NAME.length+1)??'';
}

export function reconnectCookie(ticket:string,age=RECONNECT_TTL_SECONDS):string {
  return RECONNECT_COOKIE_NAME+'='+ticket+
    '; Path=/etrade/connect; Secure; HttpOnly; SameSite=Strict; Max-Age='+age;
}

export async function issueReconnectUrl(env:Env,req:Request):Promise<string> {
  const ticket=hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.STATE.put(await ticketKey(ticket),JSON.stringify({issuedAt:Date.now()}),
    {expirationTtl:RECONNECT_TTL_SECONDS});
  const url=new URL('/etrade/connect',env.ETRADE_PUBLIC_BASE_URL||req.url);
  if(url.protocol!=='https:')throw new Error('Passwordless reconnect requires HTTPS');
  url.searchParams.set('ticket',ticket);
  return url.toString();
}

async function valid(env:Env,ticket:string):Promise<boolean> {
  if(!validShape(ticket))return false;
  const saved=await env.STATE.get<{issuedAt:number}>(await ticketKey(ticket),'json');
  return !!saved && typeof saved.issuedAt==='number' &&
    saved.issuedAt<=Date.now() && Date.now()-saved.issuedAt<RECONNECT_TTL_SECONDS*1000;
}

export async function verifyTicketFromLink(env:Env,ticket:string):Promise<boolean> {
  return valid(env,ticket);
}

export async function verifiedBrowserTicket(env:Env,req:Request):Promise<string|null> {
  const ticket=browserTicket(req);
  return await valid(env,ticket)?ticket:null;
}

/** Best-effort one-use enforcement; KV is eventually consistent across edge locations. */
export async function consumeBrowserTicket(env:Env,ticket:string):Promise<void> {
  await env.STATE.delete(await ticketKey(ticket));
}
