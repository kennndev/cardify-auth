// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from "next/server"
import { getStripeServer } from "@/lib/stripe"
import { createClient } from "@supabase/supabase-js"
import type Stripe from "stripe"

/* ───────────────────────── runtime ─────────────────────────── */
export const runtime = "nodejs"   // Buffer + supabase-js need Node

// Server-role client (SERVER ONLY)
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

// Stripe instance for MARKETPLACE tenant
const stripe = getStripeServer("market")

/* ───────────────── helper: mark tx, listing, payout ───────── */
async function handleSucceeded(pi: Stripe.PaymentIntent) {
  const stripeId   = pi.id
  const listingId  = (pi.metadata as any)?.mkt_listing_id
  const buyerId    = (pi.metadata as any)?.mkt_buyer_id
  const sellerId   = (pi.metadata as any)?.mkt_seller_id

  if (!listingId || !buyerId) {
    console.warn("[webhook] missing listingId/buyerId in PI metadata", pi.metadata)
    return
  }

  // Amounts are in cents
  const amountCents = typeof pi.amount === "number" ? pi.amount : Number(pi.amount)
  const platformFeeCents =
    typeof pi.application_fee_amount === "number"
      ? (pi.application_fee_amount ?? 0)
      : Number(pi.application_fee_amount ?? 0)
  const netCents = Math.max(0, amountCents - platformFeeCents)

  /* 1) Flip transaction row to completed */
  // First try by stripe_payment_id
  const { data: tx1, error: tx1Err } = await admin
    .from("mkt_transactions")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("stripe_payment_id", stripeId)
    .select("id")

  if (tx1Err) console.error("[webhook] tx update by stripe_id error:", tx1Err.message)

  if (!tx1?.length) {
    // Fallback by (listing,buyer) pending
    const { data: tx2, error: tx2Err } = await admin
      .from("mkt_transactions")
      .update({
        status: "completed",
        stripe_payment_id: stripeId,
        updated_at: new Date().toISOString(),
      })
      .eq("listing_id", listingId)
      .eq("buyer_id", buyerId)
      .eq("status", "pending")
      .select("id")

    if (tx2Err) console.error("[webhook] tx fallback update error:", tx2Err.message)
    console.log(`[webhook] tx rows updated (fallback): ${tx2?.length ?? 0}`)
  } else {
    console.log(`[webhook] tx rows updated: ${tx1.length}`)
  }

  /* 2) Mark listing sold */
  const { error: listErr } = await admin
    .from("mkt_listings")
    .update({ buyer_id: buyerId, status: "sold", is_active: false, updated_at: new Date().toISOString() })
    .eq("id", listingId)

  if (listErr) console.error("[webhook] listing update error:", listErr.message)

  /* 3) Schedule payout if seller has a connected account */
  if (!sellerId) return

  const { data: seller, error: sellerErr } = await admin
    .from("mkt_profiles")
    .select("stripe_account_id")
    .eq("id", sellerId)
    .single()

  if (sellerErr) {
    console.error("[webhook] fetch seller err:", sellerErr.message)
    return
  }
  if (!seller?.stripe_account_id) return // nothing to payout

  const when = new Date(Date.now() + 10 * 60 * 1000) // T+10 minutes

  const { error: payoutErr } = await admin
    .from("mkt_payouts")
    .insert({
      listing_id: listingId,
      stripe_account_id: seller.stripe_account_id,
      amount_cents: netCents,
      scheduled_at: when.toISOString(),
      status: "pending",
    })

  if (payoutErr) {
    console.error("[webhook] payout insert error:", payoutErr.message)
  } else {
    console.log(`[webhook] payout ${netCents}¢ → ${seller.stripe_account_id} @ ${when.toISOString()}`)
  }
}

/* ───────────────── route ───────────────────────────────────── */
export async function POST(req: NextRequest) {
  // A) raw body + signature verification
  const raw = await req.arrayBuffer()
  const sig = req.headers.get("stripe-signature") ?? ""
  const secret = process.env.STRIPE_WEBHOOK_SECRET_MARKET || process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error("[stripe-webhook] missing STRIPE_WEBHOOK_SECRET_MARKET")
    return new NextResponse("server misconfigured", { status: 500 })
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(Buffer.from(raw), sig, secret)
  } catch (e: any) {
    console.error("[stripe-webhook] bad signature:", e?.message ?? e)
    return new NextResponse("bad sig", { status: 400 })
  }

  // B) ACK immediately
  const res = NextResponse.json({ received: true })

  // C) Do work after ACK
  ;(async () => {
    try {
      if (event.type === "payment_intent.succeeded") {
        await handleSucceeded(event.data.object as Stripe.PaymentIntent)
      }
      // Add more handlers as needed (refunds, failures, etc.)
    } catch (err) {
      console.error("[stripe-webhook] handler error:", err)
    }
  })()

  return res
}
