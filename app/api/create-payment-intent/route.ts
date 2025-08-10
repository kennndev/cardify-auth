import { NextRequest, NextResponse } from "next/server"
import { getStripeServer } from "@/lib/stripe"
import { cookies } from "next/headers"
import { createClient } from "@supabase/supabase-js"
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs"
import type Stripe from "stripe"

// SERVER-ROLE admin client (SERVER ONLY)
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY! // keep this consistent across project
)

export async function POST(req: NextRequest) {
  const { amount, listingId, buyerId, platformFeePercent = 5 } = await req.json()

  const supabase = createRouteHandlerClient({ cookies })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!amount || !listingId || !buyerId) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 })
  }

  // 1) Look up listing & seller (bypass RLS with admin client)
  const { data: listing, error: listingErr } = await admin
    .from("mkt_listings")
    .select("seller_id")
    .eq("id", listingId)
    .single()

  if (listingErr || !listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 })
  }

  const { data: seller, error: sellerErr } = await admin
    .from("mkt_profiles")
    .select("stripe_account_id, is_admin, email, stripe_verified")
    .eq("id", listing.seller_id)
    .single()

  if (sellerErr || !seller) {
    return NextResponse.json({ error: "Seller profile missing" }, { status: 500 })
  }

  // If seller isn’t admin, they must be connected (or however you gate sellers)
  const stripeAcct = seller.is_admin ? undefined : seller.stripe_account_id ?? null
  if (!seller.is_admin && !stripeAcct) {
    return NextResponse.json({ error: "Seller not connected to Stripe" }, { status: 400 })
  }

  // 2) Money (store cents)
  const amountCents = Math.round(Number(amount) * 100)
  const feeCents = Math.round(amountCents * (Number(platformFeePercent) / 100))

  // 3) Use the MARKETPLACE Stripe account
  const stripe = getStripeServer("market")

  // 4) Reuse pending transaction if exists
  const { data: open } = await supabase
    .from("mkt_transactions")
    .select("id, stripe_payment_id")
    .eq("listing_id", listingId)
    .eq("buyer_id", buyerId)
    .eq("status", "pending")
    .single()

  const makePI = async (): Promise<Stripe.PaymentIntent> =>
    stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        // Destination charge on connected account; take platform fee
        application_fee_amount: stripeAcct ? feeCents : undefined,
        metadata: {
          mkt_listing_id: listingId,
          mkt_buyer_id: buyerId,
          mkt_seller_id: listing.seller_id,
        },
      },
      // If seller is connected, create PI on their account
      stripeAcct ? { stripeAccount: stripeAcct } : undefined
    )

  let intent: Stripe.PaymentIntent

  if (open) {
    intent = await stripe.paymentIntents.retrieve(
      open.stripe_payment_id,
      stripeAcct ? { stripeAccount: stripeAcct } : undefined
    )

    // If old PI isn't usable, create a new one and update the row
    if (intent.status !== "requires_payment_method") {
      intent = await makePI()
      await supabase
        .from("mkt_transactions")
        .update({
          stripe_payment_id: intent.id,
          seller_acct: stripeAcct,
          amount_cents: amountCents,
          platform_fee_cents: feeCents,
          currency: "USD",
        })
        .eq("id", open.id)
    }
  } else {
    intent = await makePI()
    await supabase.from("mkt_transactions").insert({
      buyer_id: buyerId,
      listing_id: listingId,
      amount_cents: amountCents,
      currency: "USD",
      stripe_payment_id: intent.id,
      status: "pending",
      seller_acct: stripeAcct,
      platform_fee_cents: feeCents,
    })
  }

  return NextResponse.json({
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    stripeAccount: stripeAcct, // send back so client can use onElements if needed
  })
}
