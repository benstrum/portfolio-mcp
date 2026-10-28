import {describe,it,expect,vi,afterEach} from 'vitest';
import {EtradeClient,snapshot} from '../src/etrade';
import {normalizeQuotes,normalizeChain,normalizeOrders,normalizePositionLots,normalizeOptionExpirations,verticalPrice} from '../src/read-models';
import {toolNames} from '../src/index';

const mockToken={token:'access',secret:'secret',obtainedAt:Date.now()};
const client=(responder:(url:string)=>Response)=>new EtradeClient(
  'consumer-key','consumer-secret',mockToken,
  async(input:RequestInfo|URL,init?:RequestInit)=>{
    expect(init?.method).toBe('GET'); // hard deny all HTTP writes
    const url=String(input);
    expect(url).toMatch(/^https:\/\/api\.etrade\.com\//);
    return responder(url);
  }
);
afterEach(()=>vi.unstubAllGlobals());

describe('market quotes',()=>{
 it('preserves real-time classification, source timestamp, bid/ask and option metadata',()=>{
   const raw={QuoteResponse:{QuoteData:[
     {Product:{symbol:'VRT',securityType:'EQ'},dateTimeUTC:1793190000,quoteStatus:'REALTIME',
       All:{bid:242.95,ask:243.05,bidSize:100,askSize:150,lastTrade:243,changeClose:34.44}},
     {Product:{symbol:'AVGO',securityType:'EQ'},quoteStatus:'DELAYED',
       All:{bid:348.3,ask:348.4,lastTrade:348.37}}
   ]}};
   const out=normalizeQuotes(raw,['AVGO','VRT']);
   expect(out.quotes[0]).toMatchObject({symbol:'AVGO',quoteStatus:'DELAYED',isRealTime:false,bid:348.3,ask:348.4});
   expect(out.quotes[1]).toMatchObject({symbol:'VRT',quoteStatus:'REALTIME',mid:243,quoteTimeUTC:1793190000,isRealTime:true});
 });
 it('does not fabricate a missing quote, 0 ask, or a mid from an invalid market',()=>{
   const raw={QuoteResponse:{QuoteData:[{Product:{symbol:'VRT'},quoteStatus:'CLOSING',All:{bid:2,ask:1}}]}};
   const q=normalizeQuotes(raw,['VRT','AVGO']).quotes;
   expect(q[0]).toMatchObject({validTwoSidedMarket:false,isRealTime:false});
   expect('mid' in q[0]?q[0].mid:undefined).toBeUndefined();
   expect(q[1]).toMatchObject({unavailable:true});
 });
 it('builds an exact six-field option ID and never uses an equity quote as its price',async()=>{
   const c=client(url=>{
     expect(url).toContain('/v1/market/quote/VRT:2027:1:15:CALL:230?detailFlag=ALL');
     return Response.json({QuoteResponse:{QuoteData:[{
       Product:{symbol:'VRT',securityType:'OPTN',callPut:'CALL',expiryYear:2027,expiryMonth:1,expiryDay:15,strikePrice:230},
       quoteStatus:'REALTIME',dateTimeUTC:1793190010,
       Option:{bid:30,ask:30.8,bidSize:15,askSize:12,lastTrade:30.25,
         osiKey:'VRT---270115C00230000',optionMultiplier:100,openInterest:1280,
         OptionGreeks:{delta:0.76,iv:0.49}}
     }]}});
   });
   const got=await c.optionQuote('VRT','2027-01-15','CALL',230);
   expect(got.quote).toMatchObject({bid:30,ask:30.8,quoteStatus:'REALTIME',
     option:{strikePrice:230,optionMultiplier:100,osiKey:'VRT---270115C00230000'}});
 });
 it('extracts both a PascalCase option chain and documented expiration dates',()=>{
   const chain=normalizeChain({OptionChainResponse:{quoteType:'DELAYED',timeStamp:1793000000,
     OptionPair:[{Call:{strikePrice:230,bid:30,ask:31,optionType:'CALL',OptionGreeks:{delta:.8}},
       Put:{strikePrice:230,bid:15,ask:16}}]}} ,'VRT','2027-01-15','BOTH');
   expect(chain.contracts).toHaveLength(2);
   expect(chain.contracts[0]).toMatchObject({type:'CALL',strikePrice:230,bid:30,ask:31,mid:30.5});
   expect(chain.quoteStatus).toBe('DELAYED');
   const dates=normalizeOptionExpirations({OptionExpireDateResponse:{expirationDates:[
     {year:2027,month:1,day:15,expiryType:'MONTHLY'}]}},'VRT');
   expect(dates.dates).toEqual([{year:2027,month:1,day:15,expiryType:'MONTHLY'}]);
 });
 it('makes the spread direction and non-executability explicit',()=>{
   const base=(symbol:string,bid:number,ask:number)=>normalizeQuotes({QuoteResponse:{QuoteData:[
     {Product:{symbol,securityType:'OPTN',callPut:'CALL',expiryYear:2026,expiryMonth:11,expiryDay:20,
       strikePrice:symbol==='LONG'?360:390},
      quoteStatus:'REALTIME',Option:{bid,ask,optionMultiplier:100}}
   ]}},[symbol]).quotes[0];
   const l=base('LONG',10.25,10.75),s=base('SHORT',3.10,3.50);
   if('unavailable' in l||'unavailable' in s)throw Error('invalid test market');
   const v=verticalPrice('AVGO','2026-11-20','CALL',360,390,l,s);
   expect(v).toMatchObject({closingCreditBid:6.75,openingDebitAsk:7.65,indicativeMid:7.2,
     estimatedClosingProceedsPerSpread:675,executableComboQuote:false});
 });
});

describe('order, lots and account reconciliation',()=>{
 it('parses OPEN order legs and next marker without actions',()=>{
   const got=normalizeOrders({OrdersResponse:{marker:'next-page',Order:[{
     orderId:456,orderType:'SPREADS',OrderDetail:[{status:'OPEN',priceType:'NET_DEBIT',
       limitPrice:10.5,orderTerm:'GOOD_FOR_DAY',Instrument:[
         {Product:{symbol:'AVGO',securityType:'OPTN',strikePrice:360},orderAction:'BUY_OPEN',quantity:3},
         {Product:{symbol:'AVGO',securityType:'OPTN',strikePrice:390},orderAction:'SELL_OPEN',quantity:3}
       ]}
     ]}]}},'masked-key','OPEN');
   expect(got.nextMarker).toBe('next-page');
   expect(got.orders[0]).toMatchObject({orderId:456,status:'OPEN',
     details:[{limitPrice:10.5,instruments:[{orderAction:'BUY_OPEN',quantity:3},{orderAction:'SELL_OPEN',quantity:3}]}]});
   expect(toolNames.some(n=>/^(place|cancel|modify|change|submit|execute|transfer)_/.test(n))).toBe(false);
   expect(toolNames).toContain('get_orders');
 });
 it('parses position tax lots, including acquisition date and basis',()=>{
   const raw={PortfolioResponse:{AccountPortfolio:[{Position:[{Product:{symbol:'BMNR'},
     positionId:321,quantity:200,PositionLot:[
       {positionLotId:11,acquiredDate:1790000000,remainingQty:100,totalCost:1500},
       {positionLotId:12,acquiredDate:1792000000,remainingQty:100,totalCost:1700}
     ]}]}]}};
   const res=normalizePositionLots(raw,'account');
   expect(res.positions[0]).toMatchObject({symbol:'BMNR',lotsAvailable:true,
     lots:[{positionLotId:11,totalCost:1500},{positionLotId:12,totalCost:1700}]});
   expect(normalizePositionLots({PortfolioResponse:{AccountPortfolio:[{Position:[{Product:{symbol:'X'}}]}]}},'account')
     .positions[0].lotsAvailable).toBe(false);
 });
 it('keeps money market positions distinct from settled cash in snapshot',()=>{
   const s=snapshot([{accountIdKey:'a',accountStatus:'ACTIVE'}],
      [{cashBalance:-100,settledCashForInvestment:0}],
      [[{symbol:'VMSXX',marketValue:1000,securityType:'MMF'},
        {symbol:'BMNR',marketValue:2000,securityType:'EQ'}]]);
   expect(s).toMatchObject({cashTotal:-100,marketValueTotal:3000,moneyMarketPositionValueTotal:1000,
     portfolioTotal:2900,totalSources:[{source:'ESTIMATED_MARKET_PLUS_CASH'}]});
 });
 it('fetches orders through GET only and preserves quote-type permissions',async()=>{
   const c=client(url=>{
     expect(url).toContain('/v1/accounts/account-key/orders?status=OPEN');
     return Response.json({OrdersResponse:{Order:[{orderId:12,OrderDetail:{status:'OPEN'}}]}});
   });
   const o=await c.orders('account-key');
   expect(o.orders).toHaveLength(1);
   expect(o.orders[0].status).toBe('OPEN');
 });
 it('exposes broker option approval and margin/settlement fields without inventing account NAV',async()=>{
   const c=client(url=>{
     expect(url).toContain('realTimeNAV=true');
     return Response.json({BalanceResponse:{accountId:'123456',accountMode:'MARGIN',optionLevel:'LEVEL_3',
       accountType:'MARGIN',quoteMode:0,Computed:{
         cashBalance:-100,cashAvailableForInvestment:0,settledCashForInvestment:0,
         marginBalance:5000,RealTimeValues:{totalAccountValue:30000}}}});
   });
   const b=await c.balance('key');
   expect(b).toMatchObject({accountMode:'MARGIN',optionLevel:'LEVEL_3',marginBalance:5000,
     settledCashForInvestment:0,totalAccountValue:30000,accountNumberMasked:'••••3456'});
 });
});
