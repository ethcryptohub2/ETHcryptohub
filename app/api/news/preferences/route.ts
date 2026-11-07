import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import {
  getNewsUserPreferences,
  getPlatformNewsSettings,
  listNewsCategories,
  updateNewsUserPreferences,
} from '../../../../lib/news-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    const [preferences, updatedSettings, categories] = await Promise.all([
      getNewsUserPreferences(user.id),
      getPlatformNewsSettings(),
      listNewsCategories(),
    ]);
    return Response.json({ data: {
      preferences,
      categories: categories.filter((category) =>
        category.is_enabled && updatedSettings.allowed_categories.includes(category.category_key),
      ),
    } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'News preferences are unavailable.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = z.object({
      enabledCategories: z.array(z.string().regex(/^[a-z]{2,40}$/)).max(20),
      tickerSymbols: z.array(z.string().regex(/^[A-Z0-9]{2,12}$/)).max(100),
      breakingNotifications: z.boolean(),
    }).strict().safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid news preferences.' }, { status: 422 });
    const settings = await getPlatformNewsSettings();
    if (parsed.data.enabledCategories.some((category) => !settings.allowed_categories.includes(category))) {
      return Response.json({ error: 'One or more selected news categories are unavailable.' }, { status: 422 });
    }
    await updateNewsUserPreferences(user.id, parsed.data);
    const [preferences, updatedSettings, categories] = await Promise.all([
      getNewsUserPreferences(user.id),
      getPlatformNewsSettings(),
      listNewsCategories(),
    ]);
    return Response.json({ data: {
      preferences,
      categories: categories.filter((category) =>
        category.is_enabled && updatedSettings.allowed_categories.includes(category.category_key),
      ),
    } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'News preferences could not be saved.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}
