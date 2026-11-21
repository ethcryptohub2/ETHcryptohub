import { SignalRecordsPage } from '../records-page';

export const dynamic = 'force-dynamic';
export default async function SignalHistoryPage({ searchParams }: { searchParams: Promise<{ scannerType?: string }> }) {
  const { scannerType } = await searchParams;
  return <SignalRecordsPage mode="history" initialScannerType={scannerType === 'HIGH_RISK' || scannerType === 'STANDARD' ? scannerType : ''} />;
}
