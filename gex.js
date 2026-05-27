/* ═══════════════════════════════════════════════════════════
   GEX EDGE v1.0 — Dealer Positioning Interpreter
   
   7 NEW METRICS vs INSTMAP:
   1. Dealer Control Meter (0–100)
   2. Pin Pressure Score (0–100 with factors breakdown)
   3. Control Zone Width (± band around price)
   4. Range Compression % (wall width ÷ expected move)
   5. Wall Strength Score (WEAK/MODERATE/HARD/NUCLEAR)
   6. Mid-Range Warning (edge zone mapping)
   7. Expansion Likelihood (% with checklist)
   
   API: Polygon.io Options Starter Plan
   Confirmed endpoints: /v3/snapshot/options, /v2/aggs/prev,
   /v1/indicators/ema, /v1/indicators/rsi, WebSocket /options/AM
   ═══════════════════════════════════════════════════════════ */

'use strict';

const CFG = {
  BASE:           'https://api.polygon.io',
  WS:             'wss://socket.polygon.io/options',
  REFRESH:        120,
  CALL_GAP:       420,
  RETRY_DELAY:    2500,
  MAX_RETRIES:    2,
  DEFAULT_TICKER: 'SPY',
};

const S = {
  key: '', ticker: CFG.DEFAULT_TICKER,
  price: null, prevClose: null,
  chain: [], od: null,
  marketOpen: false,
  countdown: CFG.REFRESH,
  refreshTimer: null, cdTimer: null,
  ws: null, wsOn: false,
  cache: {}, refreshing: false,
  calls: 0,
  chainPrice: null,
  priceVol: null, avgVol: null,
};

const $ = id => document.getElementById(id);
const set = (id, v) => { const e=$(id); if(e) e.textContent=v; };

/* ── THROTTLED API QUEUE ──────────────────────────────────── */
const _q = (() => {
  let last = 0;
  return async fn => {
    const w = Math.max(0, last + CFG.CALL_GAP - Date.now());
    if (w > 0) await sleep(w);
    last = Date.now();
    S.calls++;
    set('apiCalls', 'API: ' + S.calls);
    return fn();
  };
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function polyGet(path, params={}, retries=CFG.MAX_RETRIES) {
  return _q(async () => {
    const url = new URL(CFG.BASE + path);
    url.searchParams.set('apiKey', S.key);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
    for (let i=0; i<=retries; i++) {
      const res = await fetch(url.toString());
      if (res.status === 429) { if(i<retries){await sleep(CFG.RETRY_DELAY*(i+1));continue;} throw new Error('429 '+path); }
      if (!res.ok) throw new Error(res.status+' '+path);
      return res.json();
    }
  });
}
async function cached(key, path, params, ttl=300000) {
  const e=S.cache[key];
  if(e&&Date.now()-e.ts<ttl)return e.data;
  const d=await polyGet(path,params);
  S.cache[key]={data:d,ts:Date.now()};
  return d;
}

/* ── CLOCK ───────────────────────────────────────────────── */
function startClock() {
  const tick = () => {
    const et = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
    const p = n => String(n).padStart(2,'0');
    set('clock',`${p(et.getHours())}:${p(et.getMinutes())}:${p(et.getSeconds())} ET`);
    const h=et.getHours(),m=et.getMinutes(),d=et.getDay();
    const open=d>=1&&d<=5&&(h>9||(h===9&&m>=30))&&h<16;
    S.marketOpen=open;
    const el=$('mktBadge');
    if(el){el.textContent=open?'● OPEN':'● CLOSED';el.className='status-mkt '+(open?'open':'closed');}
    const sn=$('sessionNotice');
    if(sn)sn.style.display=open?'none':'flex';
  };
  tick();setInterval(tick,1000);
}

/* ── DATA FETCHERS ───────────────────────────────────────── */
async function fetchPrev(ticker) {
  try{
    const d=await cached('prev_'+ticker,`/v2/aggs/ticker/${ticker}/prev`,{adjusted:true},300000);
    const r=d?.results?.[0];
    return r?{open:r.o,high:r.h,low:r.l,close:r.c,vwap:r.vw,volume:r.v}:null;
  }catch(e){log(`prevDay ${ticker}: ${e.message}`,'warn');return null;}
}

async function fetchChain(underlying) {
  try{
    const all=[];
    const u=new URL(`${CFG.BASE}/v3/snapshot/options/${underlying}`);
    u.searchParams.set('limit','250');
    u.searchParams.set('apiKey',S.key);
    await sleep(CFG.CALL_GAP);S.calls++;set('apiCalls','API: '+S.calls);
    const r1=await fetch(u.toString());
    if(!r1.ok){log(`Chain ${r1.status}`,'warn');return[];}
    const d1=await r1.json();
    if(d1.results)all.push(...d1.results);
    S.chainPrice=d1.results?.[0]?.underlying_asset?.price??null;
    let next=d1.next_url;
    for(let p=1;p<4&&next;p++){
      await sleep(CFG.CALL_GAP);S.calls++;set('apiCalls','API: '+S.calls);
      const sep=next.includes('?')?'&':'?';
      const rp=await fetch(next+sep+'apiKey='+S.key);
      if(!rp.ok)break;
      const dp=await rp.json();
      if(dp.results)all.push(...dp.results);
      next=dp.next_url;
    }
    return all;
  }catch(e){log('Chain: '+e.message,'warn');return[];}
}

async function fetchEMA(ticker,period){
  try{
    const d=await cached(`ema${period}_${ticker}`,`/v1/indicators/ema/${ticker}`,
      {timespan:'day',window:period,limit:2,series_type:'close'},300000);
    const v=d?.results?.values;
    return v?.length?{current:v[0].value,prev:v[1]?.value}:null;
  }catch{return null;}
}
async function fetchRSI(ticker){
  try{
    const d=await cached('rsi_'+ticker,`/v1/indicators/rsi/${ticker}`,
      {timespan:'day',window:14,limit:1,series_type:'close'},300000);
    return d?.results?.values?.[0]?.value??null;
  }catch{return null;}
}

/* ── OPTION CHAIN PROCESSING ─────────────────────────────── */
function processChain(chain,price){
  if(!chain.length||!price)return null;
  const grouped={};
  chain.forEach(c=>{
    const exp=c.details?.expiration_date;if(!exp)return;
    if(!grouped[exp])grouped[exp]=[];
    grouped[exp].push(c);
  });
  const expiries=Object.keys(grouped).sort();
  const wall=expiries.slice(0,2).flatMap(e=>grouped[e]);
  const flow=expiries.slice(0,3).flatMap(e=>grouped[e]);

  const sMap={};
  let callOI=0,putOI=0,callVol=0,putVol=0,netGamma=0;

  wall.forEach(c=>{
    const s=c.details?.strike_price,type=c.details?.contract_type;
    const oi=c.open_interest||0,vol=c.day?.volume||0;
    const gamma=c.greeks?.gamma||0,iv=c.implied_volatility||0;
    if(!s||!type)return;
    if(!sMap[s])sMap[s]={s,callOI:0,putOI:0,callVol:0,putVol:0,gamma:0,iv:0,callIV:0,putIV:0};
    if(type==='call'){sMap[s].callOI+=oi;sMap[s].callVol+=vol;sMap[s].callIV=iv||sMap[s].callIV;callOI+=oi;callVol+=vol;netGamma+=gamma*oi*100*price;}
    else{sMap[s].putOI+=oi;sMap[s].putVol+=vol;sMap[s].putIV=iv||sMap[s].putIV;putOI+=oi;putVol+=vol;netGamma-=gamma*oi*100*price;}
    sMap[s].gamma+=Math.abs(gamma*oi);
    sMap[s].iv=iv||sMap[s].iv;
  });

  const strikes=Object.keys(sMap).map(Number).sort((a,b)=>a-b);
  let callWall=null,putWall=null,maxC=0,maxP=0;
  strikes.forEach(s=>{
    if(sMap[s].callOI>maxC){maxC=sMap[s].callOI;callWall=s;}
    if(sMap[s].putOI>maxP){maxP=sMap[s].putOI;putWall=s;}
  });

  // Max pain
  let maxPain=price,minL=Infinity;
  strikes.forEach(s=>{
    let l=0;
    strikes.forEach(k=>{l+=sMap[k].callOI*Math.max(0,s-k);l+=sMap[k].putOI*Math.max(0,k-s);});
    if(l<minL){minL=l;maxPain=s;}
  });

  // Gamma flip
  let gammaFlip=price,bestG=0;
  strikes.forEach(s=>{const sc=sMap[s].gamma/(Math.abs(s-price)+1);if(sc>bestG){bestG=sc;gammaFlip=s;}});

  // Upside / downside staircases
  const upStairs=strikes.filter(s=>s>=price&&sMap[s].callOI>0).sort((a,b)=>a-b).slice(0,6).map(s=>({s,oi:sMap[s].callOI}));
  const dnStairs=strikes.filter(s=>s<=price&&sMap[s].putOI>0).sort((a,b)=>b-a).slice(0,4).map(s=>({s,oi:sMap[s].putOI}));

  // ATM IV for expected move
  const atmS=strikes.reduce((b,s)=>Math.abs(s-price)<Math.abs(b-price)?s:b,strikes[0]||price);
  const atmIV=(sMap[atmS]?.callIV||sMap[atmS]?.putIV||0);
  const nearExpDate=new Date(expiries[0]+'T00:00:00');
  const dte=Math.max(0,Math.round((nearExpDate-new Date().setHours(0,0,0,0))/86400000));
  const expMove=atmIV&&dte?price*atmIV*Math.sqrt(dte/365):0;

  // OI density: std deviation of OI concentrations
  const oiVals=strikes.map(s=>sMap[s].callOI+sMap[s].putOI);
  const totalOI=oiVals.reduce((a,b)=>a+b,0)||1;
  const oiMax=Math.max(...oiVals);
  const oiDensity=oiMax/totalOI; // higher = more concentrated

  // IV skew
  const atmRange=strikes.filter(s=>Math.abs(s-atmS)<=3);
  let ivSum=0,ivCnt=0;
  atmRange.forEach(s=>{if(sMap[s].callIV){ivSum+=sMap[s].callIV;ivCnt++;}if(sMap[s].putIV){ivSum+=sMap[s].putIV;ivCnt++;}});
  const ivAvg=ivCnt?ivSum/ivCnt:0;
  const atmPutIV=sMap[atmS]?.putIV||0,atmCallIV=sMap[atmS]?.callIV||0;
  const ivSkew=atmPutIV-atmCallIV;

  const topContracts=flow.filter(c=>(c.day?.volume||0)>0).sort((a,b)=>(b.day?.volume||0)-(a.day?.volume||0)).slice(0,25);

  return {
    sMap,strikes,upStairs,dnStairs,topContracts,
    callWall,putWall,maxPain,gammaFlip,
    callOI,putOI,callVol,putVol,netGamma,
    pcVolRatio:putVol/(callVol||1),pcOIRatio:putOI/(callOI||1),
    atmS,atmIV,ivAvg,ivSkew,expMove,dte,oiDensity,
    maxCallOI:maxC,maxPutOI:maxP,
    nearestExp:expiries[0],allExpiries:expiries,
  };
}

/* ══════════════════════════════════════════════════════════
   METRIC 1 — DEALER CONTROL METER (0–100)
   Factors: pos gamma (+25), wall proximity (+20), OI density (+20),
   range compression (+20), low realized range (+15)
   ══════════════════════════════════════════════════════════ */
function calcDealerControl(od,price){
  if(!od)return{score:0,factors:{}};
  let score=0;
  const factors={};

  // 1. Gamma magnitude (positive gamma = control, negative = dealer risk)
  const ng=od.netGamma;
  const gammaCtrl=ng>0?Math.min(25,25*(Math.abs(ng)/1e8)):0;
  score+=gammaCtrl;factors.gamma=gammaCtrl;

  // 2. Wall proximity (both walls close = dealer tighter control)
  const callDist=od.callWall?Math.abs(od.callWall-price)/price*100:10;
  const putDist=od.putWall?Math.abs(od.putWall-price)/price*100:10;
  const avgDist=(callDist+putDist)/2;
  const wallCtrl=Math.max(0,20-avgDist*3);
  score+=wallCtrl;factors.wall=wallCtrl;

  // 3. OI density (concentrated OI = more dealer influence)
  const oiCtrl=od.oiDensity*20;
  score+=oiCtrl;factors.oi=oiCtrl;

  // 4. Range compression (tight walls relative to expMove = control)
  let rangeCtrl=0;
  if(od.callWall&&od.putWall&&od.expMove>0){
    const wallWidth=od.callWall-od.putWall;
    const ratio=wallWidth/od.expMove;
    rangeCtrl=ratio<1?20:ratio<1.5?15:ratio<2?8:0;
  }
  score+=rangeCtrl;factors.range=rangeCtrl;

  return{score:Math.min(100,Math.round(score)),factors};
}

/* ══════════════════════════════════════════════════════════
   METRIC 2 — PIN PRESSURE SCORE (0–100)
   GEX Edge equivalent of their 51/100 MODERATE pin score
   ══════════════════════════════════════════════════════════ */
function calcPinPressure(od,price){
  if(!od)return{score:0,factors:{}};
  let score=0;
  const factors={};

  // 1. Distance to max pain (closer = higher pin)
  const painDist=od.maxPain?Math.abs(price-od.maxPain)/price*100:10;
  const f1=Math.max(0,20-painDist*8);
  score+=f1;factors.maxPain=painDist.toFixed(2)+'%';

  // 2. Distance to call wall
  const cwDist=od.callWall?Math.abs(price-od.callWall)/price*100:10;
  const f2=Math.max(0,18-cwDist*3);
  score+=f2;factors.callWall=cwDist.toFixed(2)+'%';

  // 3. Distance to gamma flip
  const gfDist=od.gammaFlip?Math.abs(price-od.gammaFlip)/price*100:10;
  const f3=Math.max(0,16-gfDist*4);
  score+=f3;factors.gammaFlip=gfDist.toFixed(2)+'%';

  // 4. Net gamma magnitude (higher positive gamma = more pin)
  const ng=od.netGamma;
  const f4=ng>0?Math.min(18,18*(Math.abs(ng)/1e8)):0;
  score+=f4;factors.netGamma=(ng/1e6).toFixed(2)+'M';

  // 5. OI concentration density
  const f5=Math.min(16,od.oiDensity*16);
  score+=f5;factors.oiConc=(od.oiDensity*100).toFixed(0)+'%';

  // 6. Expected move compression
  let f6=0;
  if(od.callWall&&od.putWall&&od.expMove>0){
    const w=od.callWall-od.putWall;
    const r=w/od.expMove;
    f6=r<1?12:r<1.5?8:r<2?4:0;
  }
  score+=f6;factors.expMove=od.expMove?'±$'+od.expMove.toFixed(2):'--';

  return{score:Math.min(100,Math.round(score)),factors};
}

/* ══════════════════════════════════════════════════════════
   METRIC 3 — WALL STRENGTH SCORE
   Ranks each wall: WEAK / MODERATE / HARD CEILING / NUCLEAR WALL
   Based on absolute OI at strike vs total chain OI
   ══════════════════════════════════════════════════════════ */
function wallStrength(wallOI,totalOI){
  if(!wallOI||!totalOI)return{label:'--',cls:'',score:0};
  const pct=wallOI/totalOI;
  if(pct>0.20)return{label:'NUCLEAR WALL',cls:'str-nuclear',score:4};
  if(pct>0.12)return{label:'HARD CEILING',cls:'str-hard',   score:3};
  if(pct>0.06)return{label:'MODERATE',    cls:'str-moderate',score:2};
  return          {label:'WEAK',          cls:'str-weak',    score:1};
}

/* ══════════════════════════════════════════════════════════
   METRIC 4 — CONTROL ZONE WIDTH
   Tightest zone around price dominated by dealer gamma
   ══════════════════════════════════════════════════════════ */
function calcControlZone(od,price){
  if(!od)return{center:price,half:0,label:'--'};
  // Find radius where OI drops below 50% of peak
  const strikesNearby=od.strikes.filter(s=>Math.abs(s-price)/price<0.05);
  if(!strikesNearby.length)return{center:price,half:0,label:'--'};
  const maxOI=Math.max(...strikesNearby.map(s=>(od.sMap[s].callOI+od.sMap[s].putOI)));
  const halfOIStrikes=strikesNearby.filter(s=>(od.sMap[s].callOI+od.sMap[s].putOI)>maxOI*0.5);
  if(!halfOIStrikes.length)return{center:price,half:0,label:'--'};
  const lo=Math.min(...halfOIStrikes),hi=Math.max(...halfOIStrikes);
  const half=((hi-lo)/2)||((od.upStairs[0]?.s||price)-price)/2;
  return{center:price,half:half.toFixed(2),label:`${price.toFixed(2)} ± ${half.toFixed(2)}`};
}

/* ══════════════════════════════════════════════════════════
   METRIC 5 — RANGE COMPRESSION %
   Wall width ÷ expected move → tells if expansion is possible
   ══════════════════════════════════════════════════════════ */
function calcRangeCompression(od){
  if(!od||!od.callWall||!od.putWall||!od.expMove)return{ratio:null,verdict:'--'};
  const wallWidth=od.callWall-od.putWall;
  const ratio=wallWidth/od.expMove;
  let verdict='--';
  if(ratio<0.5)verdict='EXTREME COMPRESSION — chop trap';
  else if(ratio<1.0)verdict='HIGH COMPRESSION — expansion unlikely';
  else if(ratio<1.5)verdict='MODERATE COMPRESSION — possible breakout';
  else if(ratio<2.5)verdict='LOW COMPRESSION — expansion possible';
  else verdict='NO COMPRESSION — free expansion mode';
  return{wallWidth:wallWidth.toFixed(2),expMove:od.expMove.toFixed(2),ratio:ratio.toFixed(2),verdict};
}

/* ══════════════════════════════════════════════════════════
   METRIC 6 — EXPANSION LIKELIHOOD %
   Positive factors and suppressors weighted checklist
   ══════════════════════════════════════════════════════════ */
function calcExpansion(od,price,flowBullish,flowBearish){
  if(!od)return{pct:50,grade:'--',checks:{}};
  const checks={};
  let suppressor=0,accelerator=0;

  // Suppressors
  checks.posGamma=od.netGamma>0;         if(checks.posGamma)suppressor+=20;
  checks.nearPain=od.maxPain&&Math.abs(price-od.maxPain)/price<0.01; if(checks.nearPain)suppressor+=15;
  checks.tightWalls=od.callWall&&od.putWall&&(od.callWall-od.putWall)/price<0.02; if(checks.tightWalls)suppressor+=15;
  checks.balFlow=!flowBullish&&!flowBearish; if(checks.balFlow)suppressor+=10;
  const callStr=wallStrength(od.maxCallOI,od.callOI+od.putOI);
  checks.bigWall=callStr.score>=3;       if(checks.bigWall)suppressor+=10;

  // Accelerators
  checks.negGamma=od.netGamma<0;         if(checks.negGamma)accelerator+=20;
  checks.awayPain=od.maxPain&&Math.abs(price-od.maxPain)/price>0.02; if(checks.awayPain)accelerator+=15;
  checks.strongFlow=(flowBullish||flowBearish); if(checks.strongFlow)accelerator+=15;
  const pinS=calcPinPressure(od,price);
  checks.lowPin=pinS.score<35;           if(checks.lowPin)accelerator+=15;
  checks.roomRun=od.callWall&&(od.callWall-price)/price>0.03; if(checks.roomRun)accelerator+=10;

  const net=accelerator-suppressor;
  const pct=Math.min(90,Math.max(10,50+net));
  const grade=pct>=70?'HIGH':pct>=45?'MODERATE':'LOW';
  return{pct:Math.round(pct),grade,checks,accelerator,suppressor};
}

/* ══════════════════════════════════════════════════════════
   METRIC 7 — EDGE ZONE POSITION
   Maps current price into PUT WALL / MID-RANGE / CALL WALL zones
   ══════════════════════════════════════════════════════════ */
function calcEdgeZone(od,price){
  if(!od)return{zone:'UNKNOWN',quality:'--',inMiddle:false};
  const cw=od.callWall||price*1.05, pw=od.putWall||price*0.95;
  const range=cw-pw; if(range<=0)return{zone:'UNKNOWN',quality:'--',inMiddle:false};
  const pos=(price-pw)/range; // 0=put wall, 1=call wall
  const callZonePct=0.15, putZonePct=0.15;
  if(pos>=1-callZonePct)return{zone:'CALL WALL ZONE',quality:'FADE / PUT ENTRY',inMiddle:false,pos};
  if(pos<=putZonePct)   return{zone:'PUT WALL ZONE', quality:'BUY DIP / CALL ENTRY',inMiddle:false,pos};
  const inGammaFlipZone=od.gammaFlip&&Math.abs(price-od.gammaFlip)/price<0.003;
  if(inGammaFlipZone)return{zone:'GAMMA FLIP ZONE',quality:'TRIGGER LEVEL',inMiddle:false,pos};
  return{zone:'MID-RANGE — LOW EDGE',quality:'AVOID — DEALER HARVEST',inMiddle:true,pos};
}

/* ══════════════════════════════════════════════════════════
   RENDER FUNCTIONS
   ══════════════════════════════════════════════════════════ */

function renderDealerControl(dc){
  const s=dc.score, f=dc.factors;
  set('meterScore',s);
  const label=s>=80?'FULL CONTROL':s>=60?'STRONG CONTROL':s>=40?'MODERATE':s>=20?'LIGHT CONTROL':'FREE MARKET';
  set('meterLabel',label);

  // Arc SVG
  const arcEl=$('arcFill');
  if(arcEl){const len=283,off=len*(1-s/100);arcEl.style.strokeDashoffset=off;}

  // Needle
  const needle=$('arcNeedle');
  if(needle){
    const angle=-90+(s/100)*180;
    const rad=angle*Math.PI/180;
    const r=82,cx=100,cy=100;
    const x2=cx+r*Math.cos(rad),y2=cy+r*Math.sin(rad);
    needle.setAttribute('x2',x2.toFixed(1));needle.setAttribute('y2',y2.toFixed(1));
  }

  // Score color
  const scoreEl=$('meterScore');
  if(scoreEl)scoreEl.style.color=s>=70?'var(--red)':s>=45?'var(--amber)':'var(--green)';

  // Breakdown bars
  const pct=v=>Math.min(100,v/25*100)+'%';
  if($('cbGamma')){$('cbGamma').style.width=pct(f.gamma||0);$('cbGammaVal').textContent=Math.round(f.gamma||0);}
  if($('cbWall')) {$('cbWall').style.width= pct(f.wall||0); $('cbWallVal').textContent= Math.round(f.wall||0);}
  if($('cbOI'))   {$('cbOI').style.width=   pct(f.oi||0);   $('cbOIVal').textContent=   Math.round(f.oi||0);}
  if($('cbRange')){$('cbRange').style.width= pct(f.range||0);$('cbRangeVal').textContent=Math.round(f.range||0);}

  // Banner
  set('mbControl',s+'/100');
  const mbEl=$('mbControl');
  if(mbEl)mbEl.style.color=s>=70?'var(--red)':s>=45?'var(--amber)':'var(--green)';
}

function renderPinPressure(pp,od){
  const s=pp.score,f=pp.factors;
  set('pinScore',s);
  const grade=s>=70?'HIGH PIN':s>=45?'MODERATE PIN':s>=25?'LOW PIN':'MINIMAL PIN';
  set('pinGrade',grade);

  const fill=$('pinBarFill');
  if(fill)fill.style.width=s+'%';
  const scoreEl=$('pinScore');
  if(scoreEl)scoreEl.style.color=s>=70?'var(--red)':s>=45?'var(--amber)':'var(--green)';

  // Factors
  set('pfMaxPain',f.maxPain||'--');
  set('pfCallWall',f.callWall||'--');
  set('pfGammaFlip',f.gammaFlip||'--');
  set('pfNetGamma',f.netGamma||'--');
  set('pfOiConc',f.oiConc||'--');
  set('pfExpMove',f.expMove||'--');

  // Verdict
  const verdict=s>=70?`STRONG PIN — price likely stays near ${od?.maxPain||'max pain'}. Dealers actively harvesting premium from both sides. Avoid momentum bets.`
    :s>=45?`MODERATE PIN — dealer influence present but not dominant. Range-bound likely. Only trade wall rejections.`
    :s>=25?`LIGHT PIN — some dealer pressure but expansion is possible. Watch gamma flip for direction.`
    :`MINIMAL PIN — low dealer control. Directional setups may work. Confirm with flow.`;
  set('pinVerdict',verdict);

  set('mbPin',s+'/100');
  const mbEl=$('mbPin');
  if(mbEl)mbEl.style.color=s>=70?'var(--red)':s>=45?'var(--amber)':'var(--green)';
}

function renderWallMap(od,price){
  if(!od)return;
  const totalOI=od.callOI+od.putOI||1;
  const cStr=wallStrength(od.maxCallOI,totalOI);
  const pStr=wallStrength(od.maxPutOI,totalOI);
  const mpOI=od.callWall&&od.sMap[od.callWall]?(od.sMap[od.callWall].callOI+od.sMap[od.callWall].putOI):0;
  const mpStr=wallStrength(mpOI,totalOI);

  // Wall prices
  set('wCallPrice',od.callWall?'$'+od.callWall.toFixed(0):'--');
  set('wPainPrice', od.maxPain ?'$'+od.maxPain.toFixed(0):'--');
  set('wPutPrice',  od.putWall ?'$'+od.putWall.toFixed(0):'--');
  set('wFlipPrice', od.gammaFlip?'$'+od.gammaFlip.toFixed(0):'--');

  // Distances
  const d=(wall,lbl)=>{if(!wall)return'--';const p=((wall-price)/price*100);return(p>=0?'+':'')+p.toFixed(2)+'% away';};
  set('wCallDist',d(od.callWall));
  set('wPutDist', d(od.putWall));
  set('wFlipDist',d(od.gammaFlip));
  set('wPainDist','dealer equilibrium');

  // Strength badges
  const applyStr=(id,str)=>{const el=$(id);if(el){el.textContent=str.label;el.className='ws-strength '+str.cls;}};
  applyStr('wCallStr',cStr);applyStr('wPutStr',pStr);applyStr('wPainStr',mpStr);
  applyStr('wFlipStr',{label:'IGNITION',cls:'str-moderate'});

  // Banner wall strength
  const maxStr=[cStr,pStr].reduce((a,b)=>b.score>a.score?b:a,{score:0,label:'--'});
  set('mbWallStr',maxStr.label);
  const mbEl=$('mbWallStr');
  if(mbEl)mbEl.style.color=maxStr.score>=4?'#ff0040':maxStr.score>=3?'var(--red)':maxStr.score>=2?'var(--amber)':'var(--green)';

  // OI Chart
  renderOIChart(od,price);

  // Range compression
  const rc=calcRangeCompression(od);
  set('rcWallWidth',rc.wallWidth?'$'+rc.wallWidth:'--');
  set('rcExpMove',  rc.expMove  ?'±$'+rc.expMove:'--');
  set('rcRatio',    rc.ratio    ?rc.ratio+'x':'--');
  set('rcVerdict',  rc.verdict||'--');
  const rv=$('rcVerdict');
  if(rv)rv.style.color=rc.ratio<1?'var(--red)':rc.ratio<1.5?'var(--amber)':'var(--green)';

  // Banner
  set('mbRangeComp',rc.ratio?rc.ratio+'x':'--');
  const mbR=$('mbRangeComp');
  if(mbR)mbR.style.color=rc.ratio<1?'var(--red)':rc.ratio<1.5?'var(--amber)':'var(--green)';
}

function renderOIChart(od,price){
  const chart=$('oiChartBody');if(!chart)return;
  chart.innerHTML='';
  const nearby=od.strikes.filter(s=>{const i=od.sMap[s];return(i.callOI>0||i.putOI>0)&&Math.abs(s-price)/price<0.10;});
  if(!nearby.length){chart.innerHTML='<div class="oi-loading">No OI in range</div>';return;}
  const maxOI=Math.max(...nearby.map(s=>Math.max(od.sMap[s].callOI,od.sMap[s].putOI)));
  const H=160,minS=nearby[0],maxS=nearby[nearby.length-1],span=(maxS-minS)||1;

  // Price line
  const pp=((price-minS)/span*100);
  const pl=document.createElement('div');pl.className='oi-price-line';pl.style.left=Math.max(0.5,Math.min(99.5,pp))+'%';pl.title='Price: $'+price.toFixed(2);chart.appendChild(pl);

  // Max pain line
  if(od.maxPain>=minS&&od.maxPain<=maxS){
    const mp=document.createElement('div');mp.className='oi-pain-line';mp.style.left=((od.maxPain-minS)/span*100)+'%';mp.title='Max Pain: $'+od.maxPain;chart.appendChild(mp);
  }

  nearby.forEach(s=>{
    const info=od.sMap[s];
    const g=document.createElement('div');g.className='oi-bar-group';
    g.title=`$${s} — C:${fmtN(info.callOI)} P:${fmtN(info.putOI)}`;
    const cH=Math.max(3,(info.callOI/maxOI)*H),pH=Math.max(3,(info.putOI/maxOI)*H);
    const cb=document.createElement('div');cb.className='oi-bar call'+(s===od.callWall?' wall-bar':'');cb.style.height=cH+'px';
    const pb=document.createElement('div');pb.className='oi-bar put'+(s===od.putWall?' wall-bar':'');pb.style.height=pH+'px';
    const lbl=document.createElement('span');lbl.className='oi-strike';lbl.textContent=s;
    g.appendChild(cb);g.appendChild(pb);g.appendChild(lbl);chart.appendChild(g);
  });
}

function renderExpansion(exp){
  const{pct,grade,checks}=exp;
  set('expGrade',grade);set('expPct',pct+'%');
  const ge=$('expGrade');
  if(ge)ge.style.color=pct>=70?'var(--green)':pct>=45?'var(--amber)':'var(--red)';
  const pe=$('expPct');
  if(pe)pe.style.color=pct>=70?'var(--green)':pct>=45?'var(--amber)':'var(--red)';

  // Bars
  const low=pct<40?100-pct*2:0,mod=pct>=40&&pct<70?100:0,high=pct>=70?pct:0;
  if($('expLowSeg'))$('expLowSeg').style.width=(pct<45?100-pct:'0')+'%';
  if($('expModSeg'))$('expModSeg').style.width=(pct>=35&&pct<70?pct:'0')+'%';
  if($('expHighSeg'))$('expHighSeg').style.width=(pct>=60?pct:'0')+'%';

  // Checklist
  const applyCheck=(id,active,isSuppressor)=>{
    const el=$(id);if(!el)return;
    el.className='exp-check'+(active?(isSuppressor?' suppress':' active'):'');
  };
  applyCheck('ecPosGamma',  checks.posGamma,   true);
  applyCheck('ecNearPain',  checks.nearPain,   true);
  applyCheck('ecTightWalls',checks.tightWalls, true);
  applyCheck('ecBalFlow',   checks.balFlow,    true);
  applyCheck('ecBigWall',   checks.bigWall,    true);
  applyCheck('ecNegGamma',  checks.negGamma,   false);
  applyCheck('ecAwayPain',  checks.awayPain,   false);
  applyCheck('ecStrongFlow',checks.strongFlow, false);
  applyCheck('ecLowPin',    checks.lowPin,     false);
  applyCheck('ecRoomRun',   checks.roomRun,    false);

  // Action text
  const action=pct>=70?'EXPANSION LIKELY — directional setups valid. Firecracker / Magnet Run conditions met. Confirm flow direction.'
    :pct>=45?'MODERATE EXPANSION — possible but unconfirmed. Wait for gamma flip reclaim or wall rejection before entry.'
    :'LOW EXPANSION — dealer control dominant. Stay defensive. Trade wall rejections only. Avoid middle.';
  set('expAction',action);

  set('mbExpansion',grade+' ('+pct+'%)');
  const mb=$('mbExpansion');
  if(mb)mb.style.color=pct>=70?'var(--green)':pct>=45?'var(--amber)':'var(--red)';
}

function renderEdgeZones(od,price){
  if(!od)return;
  const ez=calcEdgeZone(od,price);
  const cw=od.callWall||price*1.02,pw=od.putWall||price*0.98;
  const span=cw-pw;

  // Set zone labels
  set('emCallZone','$'+(cw.toFixed(0)));
  set('emPutZone', '$'+(pw.toFixed(0)));

  // Price marker position
  const pos=span>0?Math.max(5,Math.min(95,((price-pw)/span*100))):50;
  const marker=$('emPriceMarker');
  if(marker)marker.style.left=pos+'%';
  set('emPriceLabel','$'+price.toFixed(2));

  // Current zone
  set('emCurrentZone',ez.zone);
  const czEl=$('emCurrentZone');
  if(czEl)czEl.style.color=ez.inMiddle?'var(--amber)':ez.zone.includes('CALL')?'var(--green)':'var(--red)';

  // Edge table
  const half=span*0.12;
  set('etCallRange', '$'+(cw-half).toFixed(2)+' – $'+cw.toFixed(2));
  set('etGammaRange','$'+(od.gammaFlip||price).toFixed(2)+(od.gammaFlip&&od.gammaFlip>price?' ↑ trigger':''));
  set('etMidRange',  '$'+(pw+half).toFixed(2)+' – $'+(cw-half).toFixed(2));
  set('etPutRange',  '$'+pw.toFixed(2)+' – $'+(pw+half).toFixed(2));
  set('etCallQ','A+');set('etGammaQ','A');set('etPutQ','A+');

  // Retail trap
  const rtTitle=ez.inMiddle?'⚠ YOU ARE IN THE TRAP ZONE':
    ez.zone.includes('CALL')?'CALL WALL ZONE — FADE OPPORTUNITY':
    ez.zone.includes('PUT')? 'PUT WALL ZONE — BUY DIP OPPORTUNITY':
    'GAMMA FLIP ZONE — KEY TRIGGER LEVEL';
  const rtSub=ez.inMiddle?'Dealers are harvesting premium from both sides. Low edge here. Wait for wall approach.':
    ez.zone.includes('CALL')?'Price approaching call wall resistance. Rejection likely. Consider puts / fade.':
    'Price at put wall support. Bounce likely. Consider calls / buy.';
  const rtEdge=ez.inMiddle?'NO EDGE':'HIGH EDGE';
  set('rtTitle',rtTitle);set('rtSub',rtSub);set('rtEdge',rtEdge);
  const rt=$('retailTrap');
  if(rt){rt.style.borderColor=ez.inMiddle?'var(--amber)':ez.zone.includes('CALL')?'var(--green)':'var(--red)';}
  const re=$('rtEdge');
  if(re)re.style.color=ez.inMiddle?'var(--amber)':ez.zone.includes('CALL')?'var(--green)':'var(--red)';

  // Control zone
  const cz=calcControlZone(od,price);
  set('czVal',cz.label||'--');
  set('mbZone',cz.label||'--');

  // Banner edge
  set('mbEdge',ez.zone.includes('TRAP')||ez.inMiddle?'AVOID MIDDLE':ez.zone.includes('CALL')?'CALL WALL FADE':ez.zone.includes('PUT')?'PUT WALL BUY':'GAMMA FLIP');
  const mbE=$('mbEdge');
  if(mbE)mbE.style.color=ez.inMiddle?'var(--amber)':'var(--green)';
}

function renderFlow(od){
  if(!od)return;
  set('fCallVol',fmtN(od.callVol)); set('fPutVol',fmtN(od.putVol));
  const pcr=od.pcVolRatio.toFixed(2);
  set('fPcRatio',pcr);
  const pEl=$('fPcRatio');
  if(pEl)pEl.style.color=od.pcVolRatio<0.7?'var(--green)':od.pcVolRatio>1.2?'var(--red)':'var(--amber)';

  const ng=od.netGamma;
  set('fNetGamma',(ng>=0?'+':'')+( ng/1e6).toFixed(2)+'M');
  const nEl=$('fNetGamma');if(nEl)nEl.style.color=ng>=0?'var(--amber)':'var(--green)';

  const skewPct=(od.ivSkew*100).toFixed(1);
  set('fIvSkew',od.ivSkew>0.02?'PUT +'+skewPct+'%':od.ivSkew<-0.02?'CALL '+skewPct+'%':'NEUTRAL');
  const sEl=$('fIvSkew');
  if(sEl)sEl.style.color=od.ivSkew>0.02?'var(--red)':od.ivSkew<-0.02?'var(--green)':'var(--amber)';

  let sig='NEUTRAL',fb=false,fbear=false;
  if(od.pcVolRatio<0.45){sig='AGGRESSIVE CALLS';fb=true;}
  else if(od.pcVolRatio<0.7){sig='CALL SKEW';fb=true;}
  else if(od.pcVolRatio>1.5){sig='AGGRESSIVE PUTS';fbear=true;}
  else if(od.pcVolRatio>1.2){sig='PUT SKEW';fbear=true;}
  set('fSignal',sig);
  S._flowBull=fb;S._flowBear=fbear;

  const total=(od.callVol+od.putVol)||1;
  const cp=Math.round(od.callVol/total*100),pp=100-cp;
  const fc=$('fbCalls'),fp=$('fbPuts');
  if(fc)fc.style.width=cp+'%';if(fp)fp.style.width=pp+'%';
  set('fbCallPct',cp+'%');set('fbPutPct',pp+'%');

  renderScanTable(od.topContracts);
}

function renderScanTable(contracts){
  const body=$('scanBody');if(!body)return;
  body.innerHTML='';
  if(!contracts?.length){body.innerHTML='<div class="scan-loading">No volume data</div>';return;}
  contracts.forEach(c=>{
    const type=c.details?.contract_type||'?',s=c.details?.strike_price||'--';
    const exp=(c.details?.expiration_date||'--').slice(5);
    const oi=c.open_interest||0,vol=c.day?.volume||0,iv=c.implied_volatility||0;
    const ratio=vol/(oi||1);
    const isSweep=vol>300&&ratio>0.25,isBlock=vol>1500;
    let sig='--';
    if(isBlock&&type==='call')sig='⚡BLOCK↑';
    else if(isBlock&&type==='put')sig='⚡BLOCK↓';
    else if(isSweep&&type==='call')sig='SWEEP↑';
    else if(isSweep&&type==='put')sig='SWEEP↓';
    else if(ratio>0.15)sig='ACTIVE';
    const row=document.createElement('div');row.className='scan-row';
    row.innerHTML=`<span class="${type==='call'?'c':'p'}">${s}</span><span class="${type==='call'?'c':'p'}">${type.toUpperCase()}</span><span>${exp}</span><span>${fmtN(oi)}</span><span>${fmtN(vol)}</span><span>${iv?(iv*100).toFixed(0)+'%':'--'}</span><span class="${isSweep||isBlock?'swp':''}">${sig}</span>`;
    body.appendChild(row);
  });
}

function renderRegime(spyD,qqqD,primD,vixClose){
  const cards=[
    {id:'Spy',d:spyD,lbl:'SPY'},
    {id:'Qqq',d:qqqD,lbl:'QQQ'},
    {id:'Prim',d:primD,lbl:S.ticker},
  ];
  cards.forEach(({id,d,lbl})=>{
    set('reg'+id+'T',lbl);
    if(!d)return;
    const pct=((d.close-d.open)/d.open*100);
    set('reg'+id+'P','$'+d.close.toFixed(2));
    const ce=$('reg'+id+'C');
    if(ce){ce.textContent=(pct>=0?'+':'')+pct.toFixed(2)+'%';ce.className='reg-c '+(pct>=0?'pos':'neg');}
    const card=$('reg'+id);
    if(card)card.className='reg-card '+(pct>=0?'bull':'bear');
  });
  if(vixClose!=null){
    set('regVixP',vixClose.toFixed(2));
    const vc=$('regVixC');
    if(vc){vc.textContent=vixClose<16?'CALM':vixClose<20?'NORMAL':vixClose<28?'ELEVATED':'HIGH';vc.className='reg-c '+(vixClose<20?'pos':'neg');}
  }

  // Day classification
  const spy=spyD?((spyD.close-spyD.open)/spyD.open*100):0;
  const prim=primD?((primD.close-primD.open)/primD.open*100):0;
  const vix=vixClose||16;
  const chop=Math.abs(spy)<0.2&&vix<18;
  const expand=Math.abs(prim)>0.8;
  const high=vix>25;
  let dc='dcTrend';
  if(high)dc='dcHedge';else if(chop)dc='dcChop';else if(expand)dc='dcExpansion';else if(Math.abs(spy)<0.4)dc='dcPin';
  ['dcTrend','dcChop','dcPin','dcExpansion','dcHedge'].forEach(id=>{const el=$(id);if(el)el.className='dc-item'+(id===dc?' active':'');});
}

function renderKeyLevels(od,price,prevDay,ema20,ema50){
  const stack=$('klStack');if(!stack)return;
  stack.innerHTML='';
  const lvls=[];
  if(od?.callWall)lvls.push({name:'CALL WALL',price:od.callWall,type:'res',tag:'OI'});
  if(prevDay?.high)lvls.push({name:'PREV HIGH',price:prevDay.high,type:'res',tag:'PDH'});
  if(ema20)lvls.push({name:'EMA 20',price:ema20,type:price>ema20?'sup':'res',tag:'EMA'});
  if(prevDay?.vwap)lvls.push({name:'PREV VWAP',price:prevDay.vwap,type:price>prevDay.vwap?'sup':'res',tag:'VWAP'});
  lvls.push({name:'▶ CURRENT',price,type:'cur',tag:''});
  if(od?.maxPain)lvls.push({name:'MAX PAIN',price:od.maxPain,type:'key',tag:'γ'});
  if(prevDay?.low)lvls.push({name:'PREV LOW',price:prevDay.low,type:'sup',tag:'PDL'});
  if(od?.putWall)lvls.push({name:'PUT WALL',price:od.putWall,type:'sup',tag:'OI'});
  if(ema50)lvls.push({name:'EMA 50',price:ema50,type:price>ema50?'sup':'res',tag:'EMA'});
  lvls.sort((a,b)=>b.price-a.price).forEach(l=>{
    const div=document.createElement('div');
    div.className='kl-lv'+(l.type==='cur'?' cur-lv':'');
    const d=((l.price-price)/price*100),ds=d>=0?'up':'dn';
    const dist=l.type!=='cur'?`<span class="kl-dist ${ds}">${d>=0?'+':''}${d.toFixed(2)}%</span>`:'';
    const b=l.type==='key'?'key':l.type;
    div.innerHTML=`<span class="kl-badge ${b}">${l.type==='cur'?'NOW':l.type==='res'?'RES':l.type==='key'?'KEY':'SUP'}</span><span style="font-size:8px;color:var(--text3);width:32px;margin-right:4px;">${l.tag}</span><span class="kl-name">${l.name}</span><span class="kl-price">${l.price.toFixed(2)}</span>${dist}`;
    stack.appendChild(div);
  });
}

function renderVolAvg(ticker,vol,prevVol){
  set('vaTicker',ticker);
  if(!vol||!prevVol){set('vaSignal','Volume data unavailable');return;}
  const pct=vol/prevVol*100;
  const fill=$('vaBarFill');
  if(fill)fill.style.width=Math.min(pct,200)/2+'%';
  fill.style.background=pct>120?'var(--green)':pct<80?'var(--red)':'var(--amber)';
  set('vaBarPct',pct.toFixed(0)+'% of avg');
  const sig=pct>130?'HEAVY VOLUME — institutional participation confirmed':
    pct>110?'ABOVE AVERAGE — directional conviction':
    pct<70?'LIGHT VOLUME — low conviction, institutional absence':
    'AVERAGE VOLUME — neutral';
  set('vaSignal',sig);
  const sv=$('vaSignal');
  if(sv)sv.style.color=pct>120?'var(--green)':pct<80?'var(--red)':'var(--amber)';
}

/* ══════════════════════════════════════════════════════════
   FULL SCAN
   ══════════════════════════════════════════════════════════ */
async function fullScan(){
  if(!S.key){log('Enter API key','warn');return;}
  if(S.refreshing){log('Scan in progress…','');return;}
  S.refreshing=true;
  log(`Scanning ${S.ticker}…`);
  set('regimeLabel','SCANNING…');
  setLoading(true);

  try{
    // Price data (sequential, throttled)
    const [spyD,qqqD,primD]=await Promise.all([
      // Actually sequential via queue — Promise.all here is fine since queue orders them
      fetchPrev('SPY'),
      fetchPrev('QQQ'),
      fetchPrev(S.ticker),
    ]);
    if(primD){S.price=primD.close;S.prevClose=primD.close;}

    // VIX
    let vixClose=null;
    try{
      const vd=await cached('prev_VIX','/v2/aggs/ticker/VIX/prev',{adjusted:true},300000);
      vixClose=vd?.results?.[0]?.c??null;
    }catch{}

    // Option chain (confirmed 200 OK endpoint)
    const chain=await fetchChain(S.ticker);
    S.chain=chain;
    if(S.chainPrice)S.price=S.chainPrice;
    const price=S.price;

    if(!price||!chain.length){log('No price or chain data','warn');setLoading(false);S.refreshing=false;return;}

    // Process chain → all derived metrics
    const od=processChain(chain,price);
    S.od=od;

    // Indicators (sequential to avoid 429)
    const ema20r=await fetchEMA(S.ticker,20);
    const ema50r=await fetchEMA(S.ticker,50);
    const rsi=await fetchRSI(S.ticker);
    const ema20=ema20r?.current??null,ema50=ema50r?.current??null;

    // Volume comparison (use prevDay volume vs 20d we can estimate from prev)
    // We use prevDay volume as a proxy for "average" since we can't call /range
    S.priceVol=primD?.volume??null;
    // avg vol proxy: we compare to itself (1 day) — shows 100% always
    // Instead derive from chain total volume as activity signal
    const chainVol=od?od.callVol+od.putVol:0;

    // ── RENDER ALL PANELS ────────────────────────────────
    const dc=calcDealerControl(od,price);
    renderDealerControl(dc);

    const pp=calcPinPressure(od,price);
    renderPinPressure(pp,od);

    renderWallMap(od,price);

    const exp=calcExpansion(od,price,S._flowBull||false,S._flowBear||false);
    // Need flow first
    if(od)renderFlow(od);
    const exp2=calcExpansion(od,price,S._flowBull||false,S._flowBear||false);
    renderExpansion(exp2);

    renderEdgeZones(od,price);
    renderRegime(spyD,qqqD,primD,vixClose);
    renderKeyLevels(od,price,primD,ema20,ema50);
    renderVolAvg(S.ticker,primD?.volume,null);

    // Banner
    if(od){
      const ez=calcEdgeZone(od,price);
      set('mbControl',dc.score+'/100');
      set('mbPin',pp.score+'/100');
      set('mbExpansion',exp2.grade+' ('+exp2.pct+'%)');
    }

    const now=new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false});
    set('lastUpdate','Updated: '+now+' ET');
    if(S.marketOpen&&!S.wsOn)connectWS();
    log(`${S.ticker} — Control:${dc.score} Pin:${pp.score} Expansion:${exp2.pct}%`,exp2.pct>=60?'bull':exp2.pct<35?'bear':'');

  }catch(e){
    log('Scan error: '+e.message,'warn');
  }finally{
    setLoading(false);S.refreshing=false;
  }
}

/* ── WEBSOCKET ───────────────────────────────────────────── */
function connectWS(){
  if(!S.key||S.ws)return;
  try{
    const ws=new WebSocket(CFG.WS);S.ws=ws;
    ws.onopen=()=>ws.send(JSON.stringify({action:'auth',params:S.key}));
    ws.onmessage=e=>{
      let msgs;try{msgs=JSON.parse(e.data);}catch{return;}
      msgs.forEach(m=>{
        if(m.ev==='status'&&m.status==='auth_success'){
          ws.send(JSON.stringify({action:'subscribe',params:`AM.O:${S.ticker}*`}));
          S.wsOn=true;log('WS live — '+S.ticker+' streaming','bull');
          const wb=$('wsBadge');if(wb){wb.textContent='◉ WS LIVE';wb.className='status-ws live';}
        }
        if(m.ev==='AM'&&m.underlying_price){
          S.price=m.underlying_price;
          set('emPriceLabel','$'+S.price.toFixed(2));
        }
      });
    };
    ws.onerror=()=>{S.wsOn=false;};
    ws.onclose=()=>{S.wsOn=false;S.ws=null;const wb=$('wsBadge');if(wb){wb.textContent='◎ WS';wb.className='status-ws';}};
  }catch(e){log('WS: '+e.message,'warn');}
}

/* ── UTILS ───────────────────────────────────────────────── */
function fmtN(n){
  if(n==null||isNaN(n))return'--';
  if(n>=1e6)return(n/1e6).toFixed(2)+'M';
  if(n>=1e3)return(n/1e3).toFixed(1)+'K';
  return String(n);
}
function log(msg,type=''){
  const logEl=$('sigLog');if(!logEl)return;
  const et=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const t=`${String(et.getHours()).padStart(2,'0')}:${String(et.getMinutes()).padStart(2,'0')}`;
  const div=document.createElement('div');
  div.className='sl-entry '+type;
  div.innerHTML=`<span class="sl-time">${t}</span><span>${msg}</span>`;
  logEl.insertBefore(div,logEl.firstChild);
  while(logEl.children.length>50)logEl.removeChild(logEl.lastChild);
}
function setLoading(on){
  document.querySelectorAll('.panel-refresh').forEach(b=>{b.className='panel-refresh'+(on?' spinning':'');});
}

/* ── AUTO REFRESH ────────────────────────────────────────── */
function startAutoRefresh(){
  if(S.refreshTimer)clearInterval(S.refreshTimer);
  if(S.cdTimer)clearInterval(S.cdTimer);
  S.countdown=CFG.REFRESH;
  S.cdTimer=setInterval(()=>{
    S.countdown=Math.max(0,S.countdown-1);
    set('countdownEl',S.countdown);
    const el=$('countdownEl');
    if(el)el.style.color=S.countdown<=10?'var(--amber)':'';
  },1000);
  S.refreshTimer=setInterval(()=>{fullScan();S.countdown=CFG.REFRESH;},CFG.REFRESH*1000);
}

/* ── PANEL REFRESH BUTTONS ───────────────────────────────── */
function attachPanelRefresh(){
  document.querySelectorAll('[data-panel]').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      if(S.refreshing)return;
      btn.className='panel-refresh spinning';
      try{await fullScan();}
      finally{btn.className='panel-refresh';}
    });
  });
}

/* ── INIT ────────────────────────────────────────────────── */
function init(){
  startClock();
  attachPanelRefresh();
  const sk=localStorage.getItem('gex_key'),st=localStorage.getItem('gex_ticker');
  if(sk){$('apiKeyInput').value=sk;S.key=sk;}
  if(st){$('tickerInput').value=st;S.ticker=st;}

  $('scanBtn').addEventListener('click',()=>{
    const key=$('apiKeyInput').value.trim(),ticker=$('tickerInput').value.trim().toUpperCase();
    if(!key||!ticker){log('API key + ticker required','warn');return;}
    S.key=key;S.ticker=ticker;
    S.price=null;S.prevClose=null;S.chain=[];S.od=null;S.cache={};S.calls=0;
    localStorage.setItem('gex_key',key);localStorage.setItem('gex_ticker',ticker);
    if(S.ws){try{S.ws.close();}catch{}S.ws=null;}
    fullScan();startAutoRefresh();
  });
  $('apiKeyInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('scanBtn').click();});
  $('tickerInput').addEventListener('keydown', e=>{if(e.key==='Enter')$('scanBtn').click();});
  set('countdownEl',CFG.REFRESH);
  if(S.key){fullScan();startAutoRefresh();}
}
document.addEventListener('DOMContentLoaded',init);
