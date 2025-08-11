// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getStripeServer } from "@/lib/stripe";
import { createClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

export const runtime = "nodejs"; // ensure raw body available

// admin client
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const stripe = getStripeServer("market");

/* helpers */

async function markSellerReadiness(acct: Stripe.Account) {
  const verified =
    acct.charges_enabled === true &&
    acct.payouts_enabled === true &&
    ((acct.requirements?.currently_due ?? []).length === 0);

  const userId = (acct.metadata as any)?.user_id as string | undefined;

  if (userId) {
    await admin
      .from("mkt_profiles")
      .upsert(
        {
          id: userId,
          email: null,
          stripe_account_id: acct.id,
          stripe_verified: verified,
          is_seller: verified,
        },
        { onConflict: "id" }
      );
  }

  await admin
    .from("mkt_profiles")
    .update({ stripe_verified: verified, is_seller: verified })
    .eq("stripe_account_id", acct.id);
}

async function handleSucceeded(pi: Stripe.PaymentIntent) {
  const stripeId = pi.id;
  const md = (pi.metadata ?? {}) as any;
  const listingId = md.mkt_listing_id;
  const buyerId = md.mkt_buyer_id;
  const sellerId = md.mkt_seller_id;

  if (!listingId || !buyerId) {
    console.warn("[wh] missing metadata", md);
    return;
  }

  const amountCents = Number(pi.amount);
  const platformFeeCents = Number(pi.application_fee_amount ?? 0);
  const netCents = Math.max(0, amountCents - platformFeeCents);

  // 1) complete tx
  const { data: tx1, error: tx1Err } = await admin
    .from("mkt_transactions")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("stripe_payment_id", stripeId)
    .select("id");

  if (tx1Err) console.error("[wh] tx by stripe_id error:", tx1Err.message);

  if (!tx1?.length) {
    const { error: tx2Err } = await admin
      .from("mkt_transactions")
      .update({
        status: "completed",
        stripe_payment_id: stripeId,
        updated_at: new Date().toISOString(),
      })
      .eq("listing_id", listingId)
      .eq("buyer_id", buyerId)
      .eq("status", "pending");

    if (tx2Err) console.error("[wh] tx fallback error:", tx2Err.message);
  }

  // 2) mark listing sold
  const { error: listErr } = await admin
    .from("mkt_listings")
    .update({
      buyer_id: buyerId,
      status: "sold",
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId);

  if (listErr) console.error("[wh] listing update err:", listErr.message);

  // 3) queue payout
  if (!sellerId) return;
  const { data: seller, error: sellerErr } = await admin
    .from("mkt_profiles")
    .select("stripe_account_id")
    .eq("id", sellerId)
    .single();

  if (sellerErr) {
    console.error("[wh] seller fetch err:", sellerErr.message);
    return;
  }
  if (!seller?.stripe_account_id) return;

  const when = new Date(Date.now() + 10 * 60 * 1000); // T+10 min
  const { error: payoutErr } = await admin.from("mkt_payouts").insert({
    listing_id: listingId,
    stripe_account_id: seller.stripe_account_id,
    amount_cents: netCents,
    scheduled_at: when.toISOString(),
    status: "pending",
  });
  if (payoutErr) console.error("[wh] payout insert err:", payoutErr.message);
}

/* route */

export async function POST(req: NextRequest) {
  // raw body + signature
  const raw = Buffer.from(await req.arrayBuffer());
  const sig = req.headers.get("stripe-signature") ?? "";

  const primary = process.env.STRIPE_WEBHOOK_SECRET;
  const connect = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

  if (!primary && !connect) {
    return new NextResponse("webhook secret missing", { status: 500 });
  }

  let event: Stripe.Event;
  try {
    // try primary; fall back to connect secret
    if (primary) {
      event = stripe.webhooks.constructEvent(raw, sig, primary);
    } else {
      throw new Error("skip primary");
    }
  } catch (e) {
    if (!connect) {
      console.error("[wh] bad signature & no connect secret:", (e as any)?.message);
      return new NextResponse("bad sig", { status: 400 });
    }
    try {
      event = stripe.webhooks.constructEvent(raw, sig, connect);
    } catch (e2) {
      console.error("[wh] bad signature (both):", (e2 as any)?.message);
      return new NextResponse("bad sig", { status: 400 });
    }
  }

  // ACK immediately
  const res = NextResponse.json({ received: true });

  // process async
  (async () => {
    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          await handleSucceeded(event.data.object as Stripe.PaymentIntent);
          break;

        case "account.updated":
        case "capability.updated":
        case "account.application.authorized":
          await markSellerReadiness(event.data.object as Stripe.Account);
          break;

        default:
          break;
      }
    } catch (err) {
      console.error("[wh] handler error:", err);
    }
  })();

  return res;
}
