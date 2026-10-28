import {oauthHeader} from './oauth1';
import {normalizeQuotes,normalizeChain,normalizeOptionExpirations,normalizeOrders,normalizePositionLots} from './read-models';
export const BASE='https://api.etrade.com';
export type Token={token:string;secret:string;obtainedAt:number};
export class EtradeError extends Error { constructor(public readonly kind:'authorization_required'|'upstream'|'unavailable',public readonly status:number,public readonly diagnostic?:{phase:string;errorType:string;causeType:string;causeCode?:string;message?:string}){super(kind);}}
const obj=(v:unknown):Record<string,any>=>v && typeof v==='object'?v as Record<string,any>:{};
const arr=(v:unknown):any[]=>v===undefined||v===null?[]:Array.isArray(v)?v:[v];
export class EtradeClient {
 constructor(private key:string,private secret:string,private token?:Token,private transport?:typeof fetch){}
 private async call(path:string,token=this.token,extra:Record<string,string>={}):Promise<Response>{
  const url=BASE+path;
  const unavailable=(phase:string,error:unknown):never=>{
   // Log only the failure category; OAuth credentials and headers must never reach logs.
   const cause = error instanceof Error ? (error as Error & {cause?: unknown}).cause : undefined;
   const message=error instanceof Error ? error.message : '';
   const secrets=[this.key,this.secret,token?.token,token?.secret].filter((value):value is string=>!!value);
   const sanitized=secrets.reduce((value,secret)=>value.replaceAll(secret,'[redacted]'),message).slice(0,240);
   const diagnostic = {
    phase,
    endpoint: new URL(url).pathname,
    errorType: error instanceof Error ? error.name : typeof error,
    causeType: cause instanceof Error ? cause.name : typeof cause,
    causeCode: cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined,
    message:phase==='fetch'?sanitized:undefined,
   };
   console.error('E*TRADE request failed', diagnostic);
   throw new EtradeError('unavailable',503,diagnostic);
  };
  let authorization:string;
  try { authorization=await oauthHeader('GET',url,this.key,this.secret,token?.token,token?.secret,extra); }
  catch(error){return unavailable('sign',error);}
  let response:Response;
  try { const options={method:'GET',headers:{Authorization:authorization,Accept:'application/json'}}; response=this.transport?await this.transport(url,options):await fetch(url,options); }
  catch(error){return unavailable('fetch',error);}
  if(!response.ok) throw new EtradeError(response.status===401||response.status===403?'authorization_required':'upstream',response.status);
  return response;
 }
 async requestToken():Promise<{token:string;secret:string;callbackConfirmed:boolean}>{const p=new URLSearchParams(await (await this.call('/oauth/request_token',undefined,{oauth_callback:'oob'})).text()); const token=p.get('oauth_token'),secret=p.get('oauth_token_secret');if(!token||!secret)throw new EtradeError('upstream',502);return {token,secret,callbackConfirmed:p.get('oauth_callback_confirmed')?.toLowerCase()==='true'};}
 async accessToken(request:{token:string;secret:string},verifier:string):Promise<Token>{const p=new URLSearchParams(await (await this.call('/oauth/access_token',{...request,obtainedAt:0},{oauth_verifier:verifier})).text());const token=p.get('oauth_token'),secret=p.get('oauth_token_secret');if(!token||!secret)throw new EtradeError('upstream',502);return {token,secret,obtainedAt:Date.now()};}
 async renew():Promise<void>{await this.call('/oauth/renew_access_token');}
 private async json(path:string):Promise<Record<string,any>>{const res=await this.call(path);if(res.status===204)return {};try{return obj(await res.json());}catch{throw new EtradeError('upstream',502);}}
 async accounts():Promise<any[]>{const d=await this.json('/v1/accounts/list');return arr(obj(obj(d.AccountListResponse).Accounts).Account).map(a=>({accountIdKey:String(a.accountIdKey),accountName:a.accountName,accountType:a.accountType,institutionType:a.institutionType,accountStatus:a.accountStatus,accountNumberMasked:mask(a.accountId)}));}
 async balance(key:string):Promise<any>{
   const d=await this.json(`/v1/accounts/${encodeURIComponent(key)}/balance?instType=BROKERAGE&realTimeNAV=true`);
   const b=obj(d.BalanceResponse);
   const c=obj(b.Computed??b.ComputedBalance??b.computedBalance);
   const cash=obj(b.Cash??b.cash);
   const margin=obj(b.Margin??b.margin);
   const realtime=obj(c.RealTimeValues??c.realTimeValues);
   return {
     accountIdKey:key,accountNumberMasked:mask(b.accountId),
     accountType:b.accountType,accountMode:b.accountMode,optionLevel:b.optionLevel,
     asOfDate:b.asOfDate,quoteMode:b.quoteMode,
     cashBalance:c.cashBalance,cashAvailableForInvestment:c.cashAvailableForInvestment,
     settledCashForInvestment:c.settledCashForInvestment,
     unSettledCashForInvestment:c.unSettledCashForInvestment,
     cashAvailableForWithdrawal:c.cashAvailableForWithdrawal,
     cashBuyingPower:c.cashBuyingPower,marginBuyingPower:c.marginBuyingPower,
     marginBalance:c.marginBalance,accountBalance:c.accountBalance,
     cashOpenOrderReserve:cash.fundsForOpenOrdersCash,
     moneyMarketSweepBalance:cash.moneyMktBalance,
     marginOpenOrderReserve:margin.dtMarginOpenOrderReserve,
     totalAccountValue:realtime.totalAccountValue,
     liquidatingEquity:obj(c.PortfolioMargin??c.portfolioMargin).liquidatingEquity
   };
 }
 async positions(key:string):Promise<any[]>{
  const out:any[]=[];
  for(let page=1;page<=100;page++){
    const d=await this.json(`/v1/accounts/${encodeURIComponent(key)}/portfolio?count=50&pageNumber=${page}&totalsRequired=true`);
    const portfolios=arr(obj(d.PortfolioResponse).AccountPortfolio);
    const p=portfolios.flatMap(x=>arr(x.Position));
    out.push(...p.map(x=>({
      accountIdKey:key,
      positionId:x.positionId,
      symbol:x.Product?.symbol??x.product?.symbol??x.symbol,
      securityType:x.Product?.securityType??x.product?.securityType,
      osiKey:x.osiKey,
      expiryYear:x.Product?.expiryYear??x.product?.expiryYear,
      expiryMonth:x.Product?.expiryMonth??x.product?.expiryMonth,
      expiryDay:x.Product?.expiryDay??x.product?.expiryDay,
      callPut:x.Product?.callPut??x.product?.callPut,
      strikePrice:x.Product?.strikePrice??x.product?.strikePrice,
      quantity:x.quantity,marketValue:x.marketValue,price:x.price,
      costBasis:x.totalCost,unrealizedGainLoss:x.totalGain,
      positionType:x.positionType,quoteStatus:x.quoteStatus??x.quotestatus,
      quoteTimeUTC:x.dateTimeUTC
    })));
    if(p.length<50)break;
  }
  return out;
 }
 async quotes(symbols:string[]){
  if(symbols.length<1||symbols.length>25||symbols.some(s=>!/^[A-Za-z0-9.:-]{1,70}$/.test(s)))
    throw new EtradeError('upstream',400);
  const encoded=symbols.map(s=>encodeURIComponent(s).replace(/%3A/gi,':')).join(',');
  return normalizeQuotes(await this.json(`/v1/market/quote/${encoded}?detailFlag=ALL`),symbols);
 }
 async optionQuote(symbol:string,expiration:string,type:'CALL'|'PUT',strike:number){
  const [year,month,day]=expiration.split('-').map(Number);
  const id=`${symbol}:${year}:${month}:${day}:${type}:${strike}`;
  const data=await this.quotes([id]);
  return {contract:id,quote:data.quotes[0],receivedAt:data.receivedAt,messages:data.messages};
 }
 async optionChain(symbol:string,expiration:string,type:'CALL'|'PUT'|'BOTH',strikePriceNear?:number,noOfStrikes=16){
  const [year,month,day]=expiration.split('-').map(Number);
  const query=new URLSearchParams({symbol,expiryYear:String(year),expiryMonth:String(month),expiryDay:String(day),
    chainType:type==='BOTH'?'CALLPUT':type,includeWeekly:'true',noOfStrikes:String(noOfStrikes)});
  if(strikePriceNear!==undefined)query.set('strikePriceNear',String(strikePriceNear));
  return normalizeChain(await this.json('/v1/market/optionchains?'+query.toString()),symbol,expiration,type);
 }
 async optionExpirations(symbol:string){
  return normalizeOptionExpirations(await this.json('/v1/market/optionexpiredate?symbol='+encodeURIComponent(symbol)+'&expiryType=ALL'),symbol);
 }
 async orders(key:string,status='OPEN',marker?:string,fromDate?:string,toDate?:string,count=50){
  const query=new URLSearchParams({status,count:String(count)});
  if(marker)query.set('marker',marker);
  if(fromDate&&toDate){query.set('fromDate',fromDate);query.set('toDate',toDate);}
  return normalizeOrders(await this.json(`/v1/accounts/${encodeURIComponent(key)}/orders?${query.toString()}`),key,status);
 }
 async positionLots(key:string):Promise<any>{
  const positions:any[]=[];
  for(let page=1;page<=100;page++){
    const result=normalizePositionLots(await this.json(
      `/v1/accounts/${encodeURIComponent(key)}/portfolio?count=50&pageNumber=${page}&lotsRequired=true&view=COMPLETE`
    ),key);
    positions.push(...result.positions);
    if(result.positions.length<50)break;
  }
  return {accountIdKey:key,positions,note:'Lots reflect broker API data; missing lots do not imply a zero cost basis'};
 }
 async transactions(key:string,startDate?:string,endDate?:string,marker?:string):Promise<any>{const q=new URLSearchParams();if(startDate)q.set('startDate',startDate);if(endDate)q.set('endDate',endDate);if(marker)q.set('marker',marker);q.set('count','50');const d=await this.json(`/v1/accounts/${encodeURIComponent(key)}/transactions?${q}`);const t=obj(d.TransactionListResponse);return {accountIdKey:key,transactions:arr(t.Transaction).map(x=>({transactionId:x.transactionId,transactionDate:x.transactionDate,amount:x.amount,description:x.description,transactionType:x.transactionType,symbol:x.brokerage?.product?.symbol})),nextMarker:t.marker,moreTransactions:t.moreTransactions};}
}
export function mask(value:unknown):string|undefined{if(value===undefined||value===null)return undefined;const s=String(value);return `••••${s.slice(-4)}`;}
export function snapshot(accounts:any[],balances:any[],positions:any[][]){
 const perAccount=accounts.map((a,i)=>{
   const b=balances[i],p=positions[i];
   const cashKnown=b.cashBalance!==undefined&&b.cashBalance!==null;
   const cash=cashKnown?Number(b.cashBalance):null;
   const marketValue=p.reduce((n,x)=>n+Number(x.marketValue??0),0);
   const moneyMarketPositionValue=p.filter(x=>x.securityType==='MMF').reduce((n,x)=>n+Number(x.marketValue??0),0);
   const brokerValue=Number(b.totalAccountValue);
   const hasBrokerValue=b.totalAccountValue!==undefined&&b.totalAccountValue!==null&&Number.isFinite(brokerValue);
   const accountTotal=hasBrokerValue?brokerValue:cash!==null?cash+marketValue:null;
   return {accountIdKey:a.accountIdKey,accountName:a.accountName,accountNumberMasked:a.accountNumberMasked,
     cash,marketValue,moneyMarketPositionValue,
     portfolioTotal:accountTotal,
     portfolioTotalSource:hasBrokerValue?'BROKER_REPORTED':'ESTIMATED_MARKET_PLUS_CASH',
     settledCashForInvestment:b.settledCashForInvestment,
     marginBalance:b.marginBalance,accountMode:b.accountMode,positions:p};
 });
 const knownCash=perAccount.filter(a=>a.cash!==null);
 const knownTotals=perAccount.filter(a=>a.portfolioTotal!==null);
 return {accounts:perAccount,positions:perAccount.flatMap(a=>a.positions),
   cashTotal:knownCash.length===perAccount.length?knownCash.reduce((n,a)=>n+a.cash!,0):null,
   marketValueTotal:perAccount.reduce((n,a)=>n+a.marketValue,0),
   moneyMarketPositionValueTotal:perAccount.reduce((n,a)=>n+a.moneyMarketPositionValue,0),
   portfolioTotal:knownTotals.length===perAccount.length?knownTotals.reduce((n,a)=>n+a.portfolioTotal!,0):null,
   totalSources:perAccount.map(a=>({accountIdKey:a.accountIdKey,source:a.portfolioTotalSource})),
   warning:'Cash excludes money-market positions. Estimated account totals may not equal net liquidation value where margin liabilities or unsettled cash are not reported.'};
}
