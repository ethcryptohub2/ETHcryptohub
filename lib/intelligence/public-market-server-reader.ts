import 'server-only';
import { query } from '../db';
import { readPublicMarketView } from './public-market-reader';

export function readPublicMarketStatus(now=Date.now()) {
  return readPublicMarketView(process.env,now,async sourceId=>{
    // Executed only after explicit feature and independently verified Staging gates.
    const result=await query<{checkpoint:unknown}>(
      'SELECT checkpoint FROM smartexit_private.public_market_streams WHERE source_id=$1 LIMIT 1',[sourceId],
    );
    return result.rows[0]??null;
  });
}
