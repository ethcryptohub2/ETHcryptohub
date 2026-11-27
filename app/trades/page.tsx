import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { TradingExecutionHistory } from '../settings/trading-execution-history';

export const dynamic = 'force-dynamic';

export default async function TradeHistoryPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <main className="shell"><section className="hero"><p className="mono">CUSTOMER EXECUTION LEDGER</p><h1>Trade History</h1><p className="muted">Exchange-confirmed executions and failed attempts for your account only.</p></section><TradingExecutionHistory /></main>;
}
