import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { NewsFeed } from './news-feed';

export const dynamic = 'force-dynamic';

export default async function NewsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <NewsFeed userId={user.id} />;
}
