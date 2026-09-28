import {oauthHeader} from './oauth1';
export const BASE='https://api.etrade.com';
export type Token={token:string;secret:string;obtainedAt:number};
export class EtradeError extends Error { constructor(public readonly kind:'authorization_required'|'upstream'|'unavailable',public readonly status:number){super(kind);}}
const obj=(v:unknown):Record<string,any>=>v && typeof v==='object'?v as Record<string,any>:{};
const arr=(v:unknown):any[]=>v===undefined||v===null?[]:Array.isArray(v)?v:[v];
export class EtradeClient {
 constructor(private key:string,private secret:string,private token?:Token,private transport:typeof fetch=fetch){}
 private async call(path:string,token=this.token,extra:Record<string,string>={}):Promise<Response>{
  const url=BASE+path;
  let response:Response;
  try { response=await this.transport(url,{method:'GET',headers:{Authorization:await oauthHeader('GET',url,this.key,this.secret,token?.token,token?.secret,extra),Accept:'application/json'}}); }
  catch {throw new EtradeError('unavailable',503);}
  if(!response.ok) throw new EtradeError(response.status===401||response.status===403?'authorization_required':'upstream',response.status);
  return response;
 }
 async requestToken():Promise<{token:string;secret:string}>{const p=new URLSearchParams(await (await this.call('/oauth/request_token',undefined,{oauth_callback:'oob'})).text()); const token=p.get('oauth_token'),secret=p.get('oauth_token_secret');if(!token||!secret)throw new EtradeError('upstream',502);return {token,secret};}
 async accessToken(request:{token:string;secret:string},verifier:string):Promise<Token>{const p=new URLSearchParams(await (await this.call('/oauth/access_token',{...request,obtainedAt:0},{oauth_verifier:verifier})).text());const token=p.get('oauth_token'),secret=p.get('oauth_token_secret');if(!token||!secret)throw new EtradeError('upstream',502);return {token,secret,obtainedAt:Date.now()};}
 async renew():Promise<void>{await this.call('/oauth/renew_access_token');}
 private async json(path:string):Promise<Record<string,any>>{const res=await this.call(path);try{return obj(await res.json());}catch{throw new EtradeError('upstream',502);}}
 async accounts():Promise<any[]>{const d=await this.json('/v1/accounts/list');return arr(obj(obj(d.AccountListResponse).Accounts).Account).map(a=>({accountIdKey:String(a.accountIdKey),accountName:a.accountName,accountType:a.accountType,institutionType:a.institutionType,accountStatus:a.accountStatus,accountNumberMasked:mask(a.accountId)}));}
 async balance(key:string):Promise<any>{const d=await this.json(`/v1/accounts/${encodeURIComponent(key)}/balance?instType=BROKERAGE`);const b=obj(d.BalanceResponse),c=obj(b.Computed);return {accountIdKey:key,accountNumberMasked:mask(b.accountId),accountType:b.accountType,cashBalance:c.cashBalance,cashAvailableForInvestment:c.cashAvailableForInvestment,totalAccountValue:obj(c.RealTimeValues).totalAccountValue??obj(c.realTimeValues).totalAccountValue};}
 async positions(key:string):Promise<any[]>{const out:any[]=[];for(let page=1;page<=100;page++){const d=await this.json(`/v1/accounts/${encodeURIComponent(key)}/portfolio?count=50&pageNumber=${page}&totalsRequired=true`);const portfolios=arr(obj(d.PortfolioResponse).AccountPortfolio);const p=portfolios.flatMap(x=>arr(x.Position));out.push(...p.map(x=>({accountIdKey:key,symbol:x.Product?.symbol??x.symbol,securityType:x.Product?.securityType,quantity:x.quantity,marketValue:x.marketValue,price:x.price,costBasis:x.totalCost,unrealizedGainLoss:x.totalGain,positionType:x.positionType})));if(p.length<50)break;}return out;}
 async transactions(key:string,startDate?:string,endDate?:string,marker?:string):Promise<any>{const q=new URLSearchParams();if(startDate)q.set('startDate',startDate);if(endDate)q.set('endDate',endDate);if(marker)q.set('marker',marker);q.set('count','50');const d=await this.json(`/v1/accounts/${encodeURIComponent(key)}/transactions?${q}`);const t=obj(d.TransactionListResponse);return {accountIdKey:key,transactions:arr(t.Transaction).map(x=>({transactionId:x.transactionId,transactionDate:x.transactionDate,amount:x.amount,description:x.description,transactionType:x.transactionType,symbol:x.brokerage?.product?.symbol})),nextMarker:t.marker,moreTransactions:t.moreTransactions};}
}
export function mask(value:unknown):string|undefined{if(value===undefined||value===null)return undefined;const s=String(value);return `••••${s.slice(-4)}`;}
export function snapshot(accounts:any[],balances:any[],positions:any[][]){const perAccount=accounts.map((a,i)=>{const b=balances[i],p=positions[i];const cash=Number(b.cashBalance??0);const marketValue=p.reduce((n,x)=>n+Number(x.marketValue??0),0);return {accountIdKey:a.accountIdKey,accountName:a.accountName,accountNumberMasked:a.accountNumberMasked,cash,marketValue,portfolioTotal:Number(b.totalAccountValue??cash+marketValue),positions:p};});return {accounts:perAccount,positions:perAccount.flatMap(a=>a.positions),cashTotal:perAccount.reduce((n,a)=>n+a.cash,0),marketValueTotal:perAccount.reduce((n,a)=>n+a.marketValue,0),portfolioTotal:perAccount.reduce((n,a)=>n+a.portfolioTotal,0)};}
