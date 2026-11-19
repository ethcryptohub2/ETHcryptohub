// Offline analysis of operator-supplied public evidence. No networking or activation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import watchlist from '../deploy/market-worker/soak-watchlist.json' with { type: 'json' };

const exact = (value, keys) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const stamp = value => Number.isSafeInteger(value) && value>0;
const positive = value => Number.isFinite(value) && value>0;
const median = values => { const sorted=[...values].sort((a,b)=>a-b), n=sorted.length; return n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2; };
export function qualifyPublicPreflight(evidence, now=Date.now()) {
  if (!stamp(now) || !exact(evidence,['version','region','collectedAt','exchangeInfoAt','symbols']) || evidence.version!==1 || evidence.region!=='sgp1' ||
      !stamp(evidence.collectedAt) || evidence.collectedAt>now || now-evidence.collectedAt>60_000 || !stamp(evidence.exchangeInfoAt) ||
      evidence.exchangeInfoAt>evidence.collectedAt || evidence.collectedAt-evidence.exchangeInfoAt>900_000 || !Array.isArray(evidence.symbols) || evidence.symbols.length!==20 ||
      new Set(evidence.symbols.map(row=>row?.symbol)).size!==20 || evidence.symbols.some(row=>!watchlist.symbols.includes(row?.symbol))) throw Error('INVALID_PREFLIGHT_EVIDENCE');
  const results=evidence.symbols.map(row=>{
    if (!exact(row,['symbol','status','quoteAsset','marginAsset','contractType','tickerAt','quoteVolume24h','high','low','last','samples']) ||
        !stamp(row.tickerAt) || row.tickerAt>evidence.collectedAt || evidence.collectedAt-row.tickerAt>60_000 ||
        ![row.quoteVolume24h,row.high,row.low,row.last].every(positive) || row.high<row.low || row.last<row.low || row.last>row.high ||
        !Array.isArray(row.samples) || row.samples.length<11 || row.samples.length>100) throw Error('INVALID_SYMBOL_EVIDENCE');
    let previous=0;
    for (const sample of row.samples) {
      if (!exact(sample,['at','bid','ask','bidDepthQuote','askDepthQuote']) || !stamp(sample.at) || sample.at<=previous || sample.at>evidence.collectedAt ||
          evidence.collectedAt-sample.at>600_000 || (previous && sample.at-previous>45_000) ||
          ![sample.bid,sample.ask,sample.bidDepthQuote,sample.askDepthQuote].every(positive) || sample.bid>=sample.ask) throw Error('INVALID_BOOK_EVIDENCE');
      previous=sample.at;
    }
    if (row.samples.at(-1).at-row.samples[0].at<300_000 || evidence.collectedAt-row.samples.at(-1).at>45_000) throw Error('INCOMPLETE_BOOK_WINDOW');
    const spreadBps=median(row.samples.map(s=>(s.ask-s.bid)/((s.ask+s.bid)/2)*10_000));
    const bidDepth=median(row.samples.map(s=>s.bidDepthQuote)), askDepth=median(row.samples.map(s=>s.askDepthQuote));
    const rangePct=(row.high-row.low)/row.last*100, reasons=[];
    if (row.status!=='TRADING'||row.quoteAsset!=='USDT'||row.marginAsset!=='USDT'||row.contractType!=='PERPETUAL') reasons.push('NOT_ELIGIBLE_USDT_PERPETUAL');
    if (row.quoteVolume24h<watchlist.qualification.minimumQuoteVolume24hUSDT) reasons.push('LOW_QUOTE_VOLUME');
    if (spreadBps>watchlist.qualification.maximumMedianSpreadBps) reasons.push('WIDE_SPREAD');
    if (Math.min(bidDepth,askDepth)<watchlist.qualification.minimumMedianTop20DepthPerSideUSDT) reasons.push('LOW_BOOK_DEPTH');
    if (rangePct<watchlist.qualification.minimum24hRangePct||rangePct>watchlist.qualification.maximum24hRangePct) reasons.push('RANGE_OUTSIDE_RESEARCH_BAND');
    return {symbol:row.symbol,qualified:reasons.length===0,spreadBps,bidDepthQuote:bidDepth,askDepthQuote:askDepth,rangePct,reasons};
  });
  return {status:results.every(r=>r.qualified)?'QUALIFIED_FROM_SUPPLIED_EVIDENCE':'STOP_REVIEW_SYMBOL_LIST',results,
    legalEligibility:'NOT_ESTABLISHED',regionalConnectivity:'NOT_ESTABLISHED',activationAuthorized:false,
    scope:'Offline qualification only; source authenticity and regional access require separately authorized timestamped provider evidence.'};
}
if (process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const file=process.argv[2];if(!file||!file.endsWith('.json'))throw Error('LOCAL_JSON_REQUIRED');
    if((await fs.stat(file)).size>8*1024*1024)throw Error('EVIDENCE_TOO_LARGE');
    const report=qualifyPublicPreflight(JSON.parse(await fs.readFile(file,'utf8')));console.log(JSON.stringify(report,null,2));
    process.exitCode=report.status==='QUALIFIED_FROM_SUPPLIED_EVIDENCE'?0:1;
  } catch { console.error('Public preflight evidence invalid, stale or incomplete. No remote action taken.');process.exitCode=1; }
}
