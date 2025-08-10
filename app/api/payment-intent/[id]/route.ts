// app/api/payment-intent/[id]/route.ts

import { NextResponse, type NextRequest } from 'next/server'
import { getStripeServer} from '@/lib/stripe'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

  const stripe = getStripeServer("market")


export async function GET(
  _req: NextRequest,
  context: any 
) {
  const id = context.params.id

  const { data: tx } = await admin
    .from('transactions')
    .select('seller_acct')
    .eq('stripe_payment_id', id)
    .single()

  if (!tx)
    return NextResponse.json({ error: 'Tx not found' }, { status: 404 })

  const intent = await stripe.paymentIntents.retrieve(
    id,
    tx.seller_acct ? { stripeAccount: tx.seller_acct } : undefined
  )

  return NextResponse.json({ intent, tx })
}

