// app/api/stripe/onboard/route.ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { getStripeServer } from '@/lib/stripe'


export async function POST() {
  const cookieStore = await cookies();
  const supabase = createRouteHandlerClient({ cookies: async () => cookieStore });


  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const stripe = getStripeServer('market');

  // read or create mkt_profiles row (avoid 406)
  const { data: profile } = await supabase
    .from('mkt_profiles')
    .select('stripe_account_id')
    .eq('id', user.id)
    .maybeSingle(); // ✅ no 406 if missing

  let accountId = profile?.stripe_account_id ?? null;

  if (!accountId) {
    // create connected account and store it
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: user.email ?? undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: { user_id: user.id },
    });
    accountId = account.id;

    // upsert profile row (creates if missing)
    await supabase.from('mkt_profiles').upsert({
      id: user.id,
      email: user.email ?? null,
      stripe_account_id: accountId,
      stripe_verified: false,
    }, { onConflict: 'id' });
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'http://localhost:3000';

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: process.env.NEXT_PUBLIC_STRIPE_REFRESH_URL || `${origin}/profile`,
    return_url: process.env.NEXT_PUBLIC_STRIPE_RETURN_URL || `${origin}/profile`,
    type: 'account_onboarding',
  });

  return NextResponse.json({ url: link.url });
}
