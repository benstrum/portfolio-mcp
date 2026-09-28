const enc = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function normalize(params: Array<[string,string]>): string {
  return params.map(([k,v]) => [enc(k),enc(v)] as const).sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([k,v])=>`${k}=${v}`).join('&');
}
export function baseString(method: string, url: string, params: Array<[string,string]>): string {
  const u = new URL(url);
  const port = u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) ? `:${u.port}` : '';
  const all = [...u.searchParams.entries(), ...params].filter(([k]) => k !== 'oauth_signature');
  return `${method.toUpperCase()}&${enc(`${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname}`)}&${enc(normalize(all))}`;
}
export async function signature(method: string, url: string, params: Array<[string,string]>, consumerSecret: string, tokenSecret = ''): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${enc(consumerSecret)}&${enc(tokenSecret)}`), {name:'HMAC',hash:'SHA-1'}, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString(method,url,params))));
  return btoa(String.fromCharCode(...bytes));
}
export async function oauthHeader(method:string,url:string, consumerKey:string,consumerSecret:string,token?:string,tokenSecret?:string,extra:Record<string,string>={}):Promise<string> {
  const params:Record<string,string>={oauth_consumer_key:consumerKey,oauth_nonce:crypto.randomUUID().replaceAll('-',''),oauth_signature_method:'HMAC-SHA1',oauth_timestamp:String(Math.floor(Date.now()/1000)),oauth_version:'1.0',...extra};
  if(token) params.oauth_token=token;
  params.oauth_signature=await signature(method,url,Object.entries(params),consumerSecret,tokenSecret);
  return 'OAuth '+Object.entries(params).map(([k,v])=>`${enc(k)}="${enc(v)}"`).join(', ');
}
