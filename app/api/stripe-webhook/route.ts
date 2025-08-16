// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse, unstable_after as after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import type Stripe from "stripe"
import { getStripeServer } from "@/lib/stripe"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const stripe = getStripeServer("market")

function getAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY")
  return createClient(url, key)
}

/* -------------- tiny logger that writes to Supabase + console -------------- */
async function logRow(phase: string, data: { event_id?: string; event_type?: string; msg?: string; details?: any } = {}) {
  try {
    console.log(`[wh][${phase}]`, data.msg ?? "", data)
    const admin = getAdmin()
    await admin.from("webhook_logs").insert({
      phase,
      event_id: data.event_id ?? null,
      event_type: data.event_type ?? null,
      msg: data.msg ?? null,
      details: data.details ?? null,
    })
  } catch (e: any) {
    console.error("[wh][log error]", e?.message)
  }
}

/* ---------------- helpers (unchanged, just with step logs) ---------------- */

async function markSellerReadiness(acct: Stripe.Account) {
  await logRow("step", { event_type: "account.*", msg: "markSellerReadiness", details: { account: acct.id } })
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
    if (error) await logRow("error", { msg: "upsert by userId failed", details: { error: error.message } })
  }

  const { error: updErr } = await admin
    .from("mkt_profiles")
    .update({ stripe_verified: verified, is_seller: verified })
    .eq("stripe_account_id", acct.id)

  if (updErr) await logRow("error", { msg: "update by stripe_account_id failed", details: { error: updErr.message } })
}

async function transferAssetToBuyer(listingId: string, buyerId: string) {
  await logRow("step", { msg: "transferAssetToBuyer start", details: { listingId, buyerId } })
  const admin = getAdmin()
  const { data: listing, error } = await admin
    .from("mkt_listings")
    .select("id, source_type, source_id")
    .eq("id", listingId)
    .single()

  if (error || !listing) {
    await logRow("error", { msg: "listing not found", details: { listingId, error: error?.message } })
    return
  }

  if (listing.source_type === "asset") {
    const { error: upErr } = await admin
      .from("user_assets")
      .update({ owner_id: buyerId })
      .eq("id", listing.source_id)
    if (upErr) await logRow("error", { msg: "transfer asset err", details: { error: upErr.message } })
    else await logRow("step", { msg: "transfer asset ok", details: { assetId: listing.source_id, buyerId } })
    return
  }

  const { error: upErr2 } = await admin
    .from("user_assets")
    .update({ owner_id: buyerId })
    .eq("source_type", "uploaded_image")
    .eq("source_id", listing.source_id)
  if (upErr2) await logRow("error", { msg: "transfer uploaded_image err", details: { error: upErr2.message } })
  else await logRow("step", { msg: "transfer uploaded_image ok", details: { sourceId: listing.source_id, buyerId } })
}

async function queuePayoutIfPossible(listingId: string, sellerId?: string | null, netCents?: number) {
  if (!sellerId || !netCents || netCents <= 0) return
  await logRow("step", { msg: "queuePayoutIfPossible", details: { listingId, sellerId, netCents } })
  const admin = getAdmin()

  const { data: seller, error: sellerErr } = await admin
    .from("mkt_profiles")
    .select("stripe_account_id")
    .eq("id", sellerId)
    .single()
  if (sellerErr) return await logRow("error", { msg: "seller fetch err", details: { error: sellerErr.message } })
  if (!seller?.stripe_account_id) return

  const when = new Date(Date.now() + 10 * 60 * 1000)
  const { error: payoutErr } = await admin.from("mkt_payouts").insert({
    listing_id: listingId,
    stripe_account_id: seller.stripe_account_id,
    amount_cents: netCents,
    scheduled_at: when.toISOString(),
    status: "pending",
  })
  if (payoutErr) await logRow("error", { msg: "payout insert err", details: { error: payoutErr.message } })
  else await logRow("step", { msg: "payout queued", details: { listingId, netCents } })
}

async function handlePaymentIntentSucceeded(pi: Stripe.PaymentIntent) {
  await logRow("step", { event_id: pi.id, event_type: "payment_intent.succeeded", msg: "PI handler start", details: { pi_md: pi.metadata } })
  const admin = getAdmin()
  const md = (pi.metadata ?? {}) as any
  const listingId = md.mkt_listing_id as string | undefined
  const buyerId = md.mkt_buyer_id as string | undefined
  const sellerId = md.mkt_seller_id as string | undefined

  if (!listingId || !buyerId) {
    await logRow("step", { msg: "PI missing marketplace metadata (might be credits flow)", details: { md } })
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
  if (tx1Err) await logRow("error", { msg: "tx by stripe_id error", details: { error: tx1Err.message } })

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
    if (tx2Err) await logRow("error", { msg: "tx fallback error", details: { error: tx2Err.message } })
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
  if (listErr) await logRow("error", { msg: "listing update err", details: { error: listErr.message } })

  await transferAssetToBuyer(listingId, buyerId)
  await queuePayoutIfPossible(listingId, sellerId, netCents)
}

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  await logRow("step", { event_type: "checkout.session.completed", msg: "CS handler start", details: { session_id: session.id, md: session.metadata } })
  const admin = getAdmin()
  const md = (session.metadata ?? {}) as any

  if (md.kind !== "credits_purchase") return

  const userId = md.userId as string | undefined
  const credits = parseInt(md.credits ?? "0", 10)
  const amount_cents = session.amount_total ?? 0
  const piId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id || session.id

  if (!userId || !credits || credits <= 0) {
    await logRow("error", { msg: "credits_purchase missing metadata", details: { userId, credits, md } })
    return
  }

  const { error: insErr } = await admin
    .from("credits_ledger")
    .insert({ user_id: userId, payment_intent: piId, amount_cents, credits, reason: "purchase" })
  if (insErr && (insErr as any).code !== "23505") {
    await logRow("error", { msg: "ledger insert err", details: { error: insErr.message } })
  }

  const { error: rpcErr } = await admin.rpc("increment_profile_credits", { p_user_id: userId, p_delta: credits })
  if (rpcErr) {
    await logRow("step", { msg: "RPC missing/failed, fallback", details: { rpcErr: rpcErr.message } })
    const { data: prof, error: readErr } = await admin
      .from("mkt_profiles")
      .select("credits")
      .eq("id", userId)
      .single()
    if (readErr) {
      const { error: createErr } = await admin.from("mkt_profiles").upsert({ id: userId, credits }, { onConflict: "id" })
      if (createErr) return await logRow("error", { msg: "upsert profile failed", details: { error: createErr.message } })
    } else {
      const current = Number(prof?.credits ?? 0)
      const { error: upErr } = await admin
        .from("mkt_profiles")
        .upsert({ id: userId, credits: current + credits }, { onConflict: "id" })
      if (upErr) return await logRow("error", { msg: "credits upsert failed", details: { error: upErr.message } })
    }
  }

  await logRow("step", { msg: "credits granted", details: { userId, credits, payment_intent: piId } })
}

/* ---------------- webhook route (with after()) ---------------- */

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const rawBody = Buffer.from(await req.arrayBuffer())
  const sig = req.headers.get("stripe-signature") ?? ""
  await logRow("received", { msg: "webhook hit", details: { len: rawBody.length } })

  const primary = process.env.STRIPE_WEBHOOK_SECRET
  const connect = process.env.STRIPE_CONNECT_WEBHOOK_SECRET
  if (!primary && !connect) {
    await logRow("error", { msg: "webhook secret missing" })
    return new NextResponse("webhook secret missing", { status: 500 })
  }

  let event: Stripe.Event | null = null
  try {
    if (primary) {
      event = stripe.webhooks.constructEvent(rawBody, sig, primary)
    } else {
      throw new Error("no primary secret")
    }
  } catch (e1: any) {
    if (!connect) {
      await logRow("error", { msg: "bad sig (primary) and no connect", details: { error: e1?.message } })
      return new NextResponse("bad sig", { status: 400 })
    }
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, connect)
    } catch (e2: any) {
      await logRow("error", { msg: "bad sig (both)", details: { error: e2?.message } })
      return new NextResponse("bad sig", { status: 400 })
    }
  }

  await logRow("verified", {
    event_id: event!.id,
    event_type: event!.type,
    msg: "signature verified",
    details: { livemode: event!.livemode, took_ms: Date.now() - t0 },
  })

  after(async () => {
    await logRow("processing_start", { event_id: event!.id, event_type: event!.type })
    try {
      switch (event!.type) {
        case "checkout.session.completed":
          await handleCheckoutSessionCompleted(event!.data.object as Stripe.Checkout.Session)
          break
        case "payment_intent.succeeded":
          await handlePaymentIntentSucceeded(event!.data.object as Stripe.PaymentIntent)
          break
        case "account.updated":
        case "capability.updated":
        case "account.application.authorized":
          await markSellerReadiness(event!.data.object as Stripe.Account)
          break
        default:
          await logRow("step", { event_id: event!.id, event_type: event!.type, msg: "ignored event" })
          break
      }
      await logRow("done", { event_id: event!.id, event_type: event!.type })
    } catch (err: any) {
      await logRow("error", { event_id: event!.id, event_type: event!.type, msg: "handler error", details: { error: err?.message } })
    }
  })

  return NextResponse.json({ received: true })
}
