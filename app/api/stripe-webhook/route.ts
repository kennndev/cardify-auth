// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse, unstable_after as after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import type Stripe from "stripe"
import { getStripeServer } from "@/lib/stripe"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Optional: extend after() work window if you ever do heavier things
// export const maxDuration = 10

const stripe = getStripeServer("market")

function getAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY")
  return createClient(url, key)
}

/* ---------------- helpers ---------------- */

async function markSellerReadiness(acct: Stripe.Account) {
  const admin = getAdmin()
  const verified =
    acct.charges_enabled === true &&
    acct.payouts_enabled === true &&
    ((acct.requirements?.currently_due ?? []).length === 0)

  const userId = (acct.metadata as any)?.user_id as string | undefined

  if (userId) {
    const { error } = await admin.from("mkt_profiles").upsert(
      {
        id: userId,
        email: null,
        stripe_account_id: acct.id,
        stripe_verified: verified,
        is_seller: verified,
      },
      { onConflict: "id" }
    )
    if (error) console.error("[wh] upsert by userId failed:", error.message)
  }

  const { error: updErr } = await admin
    .from("mkt_profiles")
    .update({ stripe_verified: verified, is_seller: verified })
    .eq("stripe_account_id", acct.id)

  if (updErr) console.error("[wh] update by stripe_account_id failed:", updErr.message)
}

async function transferAssetToBuyer(listingId: string, buyerId: string) {
  const admin = getAdmin()
  const { data: listing, error } = await admin
    .from("mkt_listings")
    .select("id, source_type, source_id")
    .eq("id", listingId)
    .single()

  if (error || !listing) {
    console.warn("[wh] transferAsset: listing not found", listingId, error?.message)
    return
  }

  if (listing.source_type === "asset") {
    const { error: upErr } = await admin
      .from("user_assets")
      .update({ owner_id: buyerId })
      .eq("id", listing.source_id)
    if (upErr) console.error("[wh] transferAsset(asset) err:", upErr.message)
    else console.log("[wh] transferAsset(asset) OK", listing.source_id, "→", buyerId)
    return
  }

  const { error: upErr2 } = await admin
    .from("user_assets")
    .update({ owner_id: buyerId })
    .eq("source_type", "uploaded_image")
    .eq("source_id", listing.source_id)
  if (upErr2) console.error("[wh] transferAsset(uploaded_image) err:", upErr2.message)
  else console.log("[wh] transferAsset(uploaded_image) OK", listing.source_id, "→", buyerId)
}

async function queuePayoutIfPossible(listingId: string, sellerId?: string | null, netCents?: number) {
  if (!sellerId || !netCents || netCents <= 0) return
  const admin = getAdmin()

  const { data: seller, error: sellerErr } = await admin
    .from("mkt_profiles")
    .select("stripe_account_id")
    .eq("id", sellerId)
    .single()
  if (sellerErr) return console.error("[wh] seller fetch err:", sellerErr.message)
  if (!seller?.stripe_account_id) return

  const when = new Date(Date.now() + 10 * 60 * 1000) // schedule in 10 min (demo)
  const { error: payoutErr } = await admin.from("mkt_payouts").insert({
    listing_id: listingId,
    stripe_account_id: seller.stripe_account_id,
    amount_cents: netCents,
    scheduled_at: when.toISOString(),
    status: "pending",
  })
  if (payoutErr) console.error("[wh] payout insert err:", payoutErr.message)
  else console.log("[wh] payout queued:", listingId, netCents)
}

async function handlePaymentIntentSucceededMarketplace(pi: Stripe.PaymentIntent) {
  console.log("[wh] PI marketplace handler start; md:", pi.metadata)
  const admin = getAdmin()
  const md = (pi.metadata ?? {}) as any
  const listingId = md.mkt_listing_id as string | undefined
  const buyerId = md.mkt_buyer_id as string | undefined
  const sellerId = md.mkt_seller_id as string | undefined

  if (!listingId || !buyerId) {
    console.warn("[wh] PI missing marketplace metadata", { listingId, buyerId, md })
    return
  }

  const stripeId = pi.id
  const amountCents = Number(pi.amount)
  const platformFeeCents = Number(pi.application_fee_amount ?? 0)
  const netCents = Math.max(0, amountCents - platformFeeCents)

  const { data: tx1, error: tx1Err } = await admin
    .from("mkt_transactions")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("stripe_payment_id", stripeId)
    .select("id")
  if (tx1Err) console.error("[wh] tx by stripe_id error:", tx1Err.message)

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
      .eq("status", "pending")
    if (tx2Err) console.error("[wh] tx fallback error:", tx2Err.message)
  }

  const { error: listErr } = await admin
    .from("mkt_listings")
    .update({
      buyer_id: buyerId,
      status: "sold",
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId)
  if (listErr) console.error("[wh] listing update err:", listErr.message)

  await transferAssetToBuyer(listingId, buyerId)
  await queuePayoutIfPossible(listingId, sellerId, netCents)
}

/* ---------------- credits from Checkout ---------------- */

async function grantCreditsFromSessionLike(obj: {
  amount_total?: number | null
  metadata?: Record<string, any> | null
  payment_intent?: string | Stripe.PaymentIntent | null
  id?: string
}) {
  const admin = getAdmin()
  const md = (obj.metadata ?? {}) as any
  console.log("[wh] credits metadata:", md)

  if (md.kind !== "credits_purchase") return

  const userId = md.userId as string | undefined
  const credits = parseInt(md.credits ?? "0", 10)
  const amount_cents = obj.amount_total ?? 0
  const piId =
    typeof obj.payment_intent === "string"
      ? obj.payment_intent
      : (obj.payment_intent as Stripe.PaymentIntent | undefined)?.id || obj.id

  if (!userId || !credits || credits <= 0) {
    console.warn("[wh] credits_purchase missing metadata", { userId, credits, md })
    return
  }

  // 1) ledger (idempotent: add a unique key on payment_intent in SQL)
  const { error: insErr } = await admin
    .from("credits_ledger")
    .insert({
      user_id: userId,
      payment_intent: piId,
      amount_cents,
      credits,
      reason: "purchase",
    })
  if (insErr && (insErr as any).code !== "23505") {
    console.error("[wh] ledger insert err:", insErr.message)
  }

  // 2) increment credits (RPC or fallback)
  const { error: rpcErr } = await admin.rpc("increment_profile_credits", {
    p_user_id: userId,
    p_delta: credits,
  })
  if (rpcErr) {
    console.warn("[wh] RPC missing/failed, fallback:", rpcErr.message)
    const { data: prof, error: readErr } = await admin
      .from("mkt_profiles")
      .select("credits")
      .eq("id", userId)
      .single()
    if (readErr) {
      const { error: createErr } = await admin
        .from("mkt_profiles")
        .upsert({ id: userId, credits }, { onConflict: "id" })
      if (createErr) return console.error("[wh] upsert profile failed:", createErr.message)
    } else {
      const current = Number(prof?.credits ?? 0)
      const { error: upErr } = await admin
        .from("mkt_profiles")
        .upsert({ id: userId, credits: current + credits }, { onConflict: "id" })
      if (upErr) return console.error("[wh] credits upsert failed:", upErr.message)
    }
  }

  console.log("[wh] credits granted:", { userId, credits, payment_intent: piId })
}

/* ---------------- webhook route ---------------- */

export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer())
  const sig = req.headers.get("stripe-signature") ?? ""

  const primary = process.env.STRIPE_WEBHOOK_SECRET
  const connect = process.env.STRIPE_CONNECT_WEBHOOK_SECRET
  if (!primary && !connect) {
    return new NextResponse("webhook secret missing", { status: 500 })
  }

  let event: Stripe.Event | null = null
  try {
    if (primary) {
      event = stripe.webhooks.constructEvent(rawBody, sig, primary)
    } else {
      throw new Error("no primary")
    }
  } catch (e1: any) {
    if (!connect) {
      console.error("[wh] bad signature (primary) & no connect:", e1?.message)
      return new NextResponse("bad sig", { status: 400 })
    }
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, connect)
    } catch (e2: any) {
      console.error("[wh] bad signature (both):", e2?.message)
      return new NextResponse("bad sig", { status: 400 })
    }
  }

  console.log("[wh] received:", event.type, "id:", event.id, "livemode:", event.livemode)

  // schedule processing after the 200 OK is sent
  after(async () => {
    try {
      switch (event!.type) {
        case "checkout.session.completed": {
          const session = event!.data.object as Stripe.Checkout.Session
          console.log("[wh] session metadata:", session.metadata)
          await grantCreditsFromSessionLike({
            id: session.id,
            amount_total: session.amount_total,
            metadata: session.metadata as any,
            payment_intent: session.payment_intent as any,
          })
          break
        }

        case "payment_intent.succeeded": {
          const pi = event!.data.object as Stripe.PaymentIntent
          console.log("[wh] pi metadata:", pi.metadata)

          // Fallback: if this PI is a credits purchase, grant credits here too
          const md = (pi.metadata ?? {}) as any
          if (md.kind === "credits_purchase" && md.userId && md.credits) {
            await grantCreditsFromSessionLike({
              id: pi.id,
              amount_total: pi.amount_received ?? pi.amount ?? 0,
              metadata: md,
              payment_intent: pi.id,
            })
            break
          }

          // Otherwise: marketplace flow
          await handlePaymentIntentSucceededMarketplace(pi)
          break
        }

        case "account.updated":
        case "capability.updated":
        case "account.application.authorized":
          await markSellerReadiness(event!.data.object as Stripe.Account)
          break

        default:
          // no-op
          break
      }
    } catch (err) {
      console.error("[wh] handler error:", err)
    }
  })

  // immediate ACK so Stripe doesn't retry
  return NextResponse.json({ received: true })
}
