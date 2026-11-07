import { SignalRecordsPage } from '../records-page';

export const dynamic = 'force-dynamic';
export default function SignalHistoryPage() {
  return <SignalRecordsPage mode="history" />;
}
