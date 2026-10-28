/**
 * Read-only normalization of the documented E*TRADE response schemas.
 * E*TRADE has used both PascalCase XML-converted and camelCase JSON property names.
 * Missing prices are never substituted with zero.
 */
export type Dict=Record<string,unknown>;
export const record=(v:unknown):Dict => v!==null && typeof v==='object' && !Array.isArray(v) ? v as Dict : {};
export const items=(v:unknown):unknown[] => v===null||v===undefined?[]:Array.isArray(v)?v:[v];
export function pick(v:unknown,...names:string[]):unknown {
  const d=record(v);
  for(const name of names)if(Object.prototype.hasOwnProperty.call(d,name))return d[name];
  const keys=Object.keys(d);
  for(const name of names){const found=keys.find(k=>k.toLowerCase()===name.toLowerCase());if(found!==undefined)return d[found];}
  return undefined;
}
export function amount(v:unknown):number|undefined {
  if(v===undefined||v===null||v==='')return undefined;
  const n=Number(v);
  return Number.isFinite(n)?n:undefined;
}
const name=(v:unknown)=>v===null||v===undefined?undefined:String(v);
const sourceTimestamp=(v:unknown)=>amount(v);
const greeks=(v:unknown)=>{
  const o=record(v);
  if(!Object.keys(o).length)return undefined;
  const out:Dict={};
  for(const k of ['delta','gamma','theta','vega','rho','iv']){
    const n=amount(pick(o,k));if(n!==undefined)out[k]=n;
  }
  if(pick(o,'currentValue')!==undefined)out.currentValue=pick(o,'currentValue')===true||pick(o,'currentValue')==='true';
  return Object.keys(out).length?out:undefined;
};
export function normalizeQuote(q:unknown,requestedSymbol?:string) {
  const product=record(pick(q,'Product'));
  const all=record(pick(q,'All'));
  const opts=record(pick(q,'Option'));
  const details=Object.keys(all).length?all:Object.keys(opts).length?opts:record(pick(q,'Intraday'));
  const bid=amount(pick(details,'bid')),ask=amount(pick(details,'ask'));
  const validMarket=bid!==undefined&&ask!==undefined&&bid>=0&&ask>=bid;
  const quoteStatus=name(pick(q,'quoteStatus'))??'UNKNOWN';
  const contractSize=amount(pick(details,'contractSize')),optionMultiplier=amount(pick(details,'optionMultiplier'));
  const s={
    requestedSymbol,
    symbol:name(pick(product,'symbol'))??requestedSymbol,
    securityType:name(pick(product,'securityType')),
    quoteStatus,
    quoteTimeUTC:sourceTimestamp(pick(q,'dateTimeUTC')),
    quoteTime:name(pick(q,'dateTime')),
    fetchedAt:new Date().toISOString(),
    bid,ask,mid:validMarket?(bid!+ask!)/2:undefined,
    bidSize:amount(pick(details,'bidSize')),askSize:amount(pick(details,'askSize')),
    last:amount(pick(details,'lastTrade','lastPrice','last')),
    lastTradeTime:sourceTimestamp(pick(details,'timeOfLastTrade','lastTradeTime')),
    previousClose:amount(pick(details,'previousClose')),
    change:amount(pick(details,'changeClose','change')),
    changePct:amount(pick(details,'changeClosePercentage','changePct')),
    volume:amount(pick(details,'totalVolume','volume')),
    option:{
      callPut:name(pick(product,'callPut')),
      expiryYear:amount(pick(product,'expiryYear')),expiryMonth:amount(pick(product,'expiryMonth')),expiryDay:amount(pick(product,'expiryDay')),
      strikePrice:amount(pick(product,'strikePrice')),
      osiKey:name(pick(details,'osiKey')),
      optionMultiplier,contractSize,adjusted:pick(details,'adjustedFlag'),
      openInterest:amount(pick(details,'openInterest')),
      daysToExpiration:amount(pick(details,'daysToExpiration')),
      greeks:greeks(pick(details,'OptionGreeks','optionGreeks'))
    },
    validTwoSidedMarket:validMarket,
    isRealTime:quoteStatus==='REALTIME'||quoteStatus==='EH_REALTIME'||quoteStatus==='INDICATIVE_REALTIME'
  };
  return s;
}
export type NormalizedQuote=ReturnType<typeof normalizeQuote>;
export function normalizeQuotes(raw:unknown,requestedSymbols:string[]) {
  const d=record(pick(raw,'QuoteResponse'));
  const quoted=items(pick(d,'QuoteData'));
  const messages=items(pick(pick(d,'Messages'),'Message')).map(m=>({
    code:amount(pick(m,'code')),type:name(pick(m,'type')),description:name(pick(m,'description'))
  }));
  // Quote responses do not always preserve request order. Match by product metadata when unambiguous.
  const normalized=quoted.map(q=>normalizeQuote(q));
  const result=requestedSymbols.map(requested=>{
    const exact=normalized.filter(x=>x.symbol===requested);
    // An option request has a colon-delimited format but product.symbol may only be the underlying;
    // use the six fields to match rather than assigning an unrelated option quote.
    const p=requested.split(':');
    const matched=p.length===6?normalized.filter(x=>
      x.symbol===p[0] && x.option.expiryYear===Number(p[1]) && x.option.expiryMonth===Number(p[2]) &&
      x.option.expiryDay===Number(p[3]) && x.option.callPut===p[4] && x.option.strikePrice===Number(p[5])
    ):exact;
    const chosen=matched.length===1?matched[0] : requestedSymbols.length===1&&normalized.length===1?normalized[0]:undefined;
    return chosen?{...chosen,requestedSymbol:requested}:{
      requestedSymbol:requested,unavailable:true as const,reason:'No unambiguous matching quote returned'
    };
  });
  return {quotes:result,messages,requestedSymbols,receivedAt:new Date().toISOString(),source:'E*TRADE market quote API'};
}
export function normalizeChain(raw:unknown,symbol:string,expiration:string,optionType:'CALL'|'PUT'|'BOTH') {
  const d=record(pick(raw,'OptionChainResponse'));
  const result=items(pick(d,'OptionPair','optionPairs')).flatMap(pair=>{
    const out:Dict[]=[];
    const sides=optionType==='CALL'?['CALL']:optionType==='PUT'?['PUT']:['CALL','PUT'];
    for(const side of sides) {
      const item=pick(pair,side==='CALL'?'Call':'Put',side==='CALL'?'optioncall':'optionPut');
      if(!item)continue;
      const o=record(item), bid=amount(pick(o,'bid')),ask=amount(pick(o,'ask'));
      out.push({
        type:side,displaySymbol:name(pick(o,'displaySymbol')),strikePrice:amount(pick(o,'strikePrice')),
        bid,ask,bidSize:amount(pick(o,'bidSize')),askSize:amount(pick(o,'askSize')),
        mid:bid!==undefined&&ask!==undefined&&bid>=0&&ask>=bid?(bid+ask)/2:undefined,
        last:amount(pick(o,'lastPrice')),volume:amount(pick(o,'volume')),openInterest:amount(pick(o,'openInterest')),
        osiKey:name(pick(o,'osiKey')),quoteTimeUTC:sourceTimestamp(pick(o,'timeStamp')),
        adjusted:pick(o,'adjustedFlag'),greeks:greeks(pick(o,'OptionGreeks','optionGreek'))
      });
    }
    return out;
  });
  return {symbol,expiration,optionType,quoteStatus:name(pick(d,'quoteType'))??'UNKNOWN',
    quoteTimeUTC:sourceTimestamp(pick(d,'timeStamp')),underlyingNearPrice:amount(pick(d,'nearPrice')),
    contracts:result,receivedAt:new Date().toISOString()};
}
export function normalizeOptionExpirations(raw:unknown,symbol:string) {
  const d=pick(raw,'OptionExpireDateResponse');
  return {symbol,dates:items(pick(d,'ExpirationDate')).map(e=>({
    year:amount(pick(e,'year')),month:amount(pick(e,'month')),day:amount(pick(e,'day')),
    expiryType:name(pick(e,'expiryType'))
  }))};
}
export function normalizeOrders(raw:unknown,accountIdKey:string,status?:string) {
  const root=record(pick(raw,'OrdersResponse'));
  const rows=items(pick(root,'Order'));
  return {accountIdKey,requestedStatus:status,orders:rows.map(item=>{
    const d=record(item),details=items(pick(d,'OrderDetail')).map(detail=>{
      const l=record(detail);
      return {
        status:name(pick(l,'status')),orderType:name(pick(l,'orderType')),
        placedTime:sourceTimestamp(pick(l,'placedTime')),
        executedTime:sourceTimestamp(pick(l,'executedTime')),
        priceType:name(pick(l,'priceType')),limitPrice:amount(pick(l,'limitPrice')),
        stopPrice:amount(pick(l,'stopPrice')),netPrice:amount(pick(l,'netPrice')),
        netBid:amount(pick(l,'netBid')),netAsk:amount(pick(l,'netAsk')),
        orderTerm:name(pick(l,'orderTerm')),marketSession:name(pick(l,'marketSession')),
        orderValue:amount(pick(l,'orderValue')),
        instruments:items(pick(l,'Instrument')).map(i=>({
          symbol:name(pick(pick(i,'Product'),'symbol')),
          securityType:name(pick(pick(i,'Product'),'securityType')),
          callPut:name(pick(pick(i,'Product'),'callPut')),
          expiryYear:amount(pick(pick(i,'Product'),'expiryYear')),
          expiryMonth:amount(pick(pick(i,'Product'),'expiryMonth')),
          expiryDay:amount(pick(pick(i,'Product'),'expiryDay')),
          strikePrice:amount(pick(pick(i,'Product'),'strikePrice')),
          orderAction:name(pick(i,'orderAction')),quantity:amount(pick(i,'quantity')),
          filledQuantity:amount(pick(i,'filledQuantity'))
        }))
      };
    });
    return {orderId:pick(d,'orderId'),orderType:name(pick(d,'orderType')),
      status:details[details.length-1]?.status,details};
  }),nextMarker:name(pick(root,'marker')),moreOrders:!!pick(root,'next')};
}
export function normalizePositionLots(raw:unknown,accountIdKey:string) {
  const root=record(pick(raw,'PortfolioResponse'));
  const out=items(pick(root,'AccountPortfolio')).flatMap(a=>items(pick(a,'Position')));
  return {accountIdKey,positions:out.map(p=>{
    const lots=items(pick(p,'PositionLot')).map(l=>({
      positionLotId:pick(l,'positionLotId'),acquiredDate:sourceTimestamp(pick(l,'acquiredDate')),
      remainingQty:amount(pick(l,'remainingQty')),availableQty:amount(pick(l,'availableQty')),
      originalQty:amount(pick(l,'originalQty')),totalCost:amount(pick(l,'totalCost')),
      totalGain:amount(pick(l,'totalGain')),marketValue:amount(pick(l,'marketValue')),
      termCode:pick(l,'termCode'),lotSourceCode:pick(l,'lotSourceCode'),
      adjustedPrice:amount(pick(l,'adjPrice')),commissionsPerShare:amount(pick(l,'commPerShare'))
    }));
    return {symbol:name(pick(pick(p,'Product'),'symbol'))??name(pick(p,'symbol')),
      positionId:pick(p,'positionId'),securityType:name(pick(pick(p,'Product'),'securityType')),
      positionQuantity:amount(pick(p,'quantity')),lotsAvailable:lots.length>0,lots};
  }),note:'Lots reflect broker API data; missing lots do not imply a zero cost basis'};
}
export function verticalPrice(underlying:string,expiration:string,type:'CALL'|'PUT',
 longStrike:number,shortStrike:number,long:NormalizedQuote,short:NormalizedQuote) {
  const compatible=long.validTwoSidedMarket && short.validTwoSidedMarket
    && long.bid!==undefined&&long.ask!==undefined&&short.bid!==undefined&&short.ask!==undefined;
  const closeBid=compatible?Number((long.bid!-short.ask!).toFixed(4)):undefined;
  const openAsk=compatible?Number((long.ask!-short.bid!).toFixed(4)):undefined;
  const mid=compatible?Number(((closeBid!+openAsk!)/2).toFixed(4)):undefined;
  const sameMultiplier=long.option.optionMultiplier && short.option.optionMultiplier
    && long.option.optionMultiplier===short.option.optionMultiplier?long.option.optionMultiplier:undefined;
  const realTime=long.isRealTime&&short.isRealTime;
  return {underlying,expiration,type,longStrike,shortStrike,longLeg:long,shortLeg:short,
    closingCreditBid:closeBid,openingDebitAsk:openAsk,indicativeMid:mid,
    estimatedClosingProceedsPerSpread:sameMultiplier?closeBid!*sameMultiplier:undefined,
    estimatedOpeningCostPerSpread:sameMultiplier?openAsk!*sameMultiplier:undefined,
    contractMultiplier:sameMultiplier,quoteStatus:realTime?'REALTIME_OR_INDICATIVE':'DELAYED_OR_UNKNOWN',
    executableComboQuote:false,
    warning:'Derived from separate leg quotes, not an executable combination-market quote. Quote age, market hours and order fill can differ. Verify directly in E*TRADE before trading.'};
}
