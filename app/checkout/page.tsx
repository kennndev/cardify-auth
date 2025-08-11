'use client'

import { useEffect, useMemo, useState } from 'react'
import { loadStripe, type Stripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { useSearchParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'

/** Load Stripe for the (optional) connected account */
function useStripeLoader(acct: string | null) {
  return useMemo<Promise<Stripe | null>>(
    () => loadStripe(
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
      acct ? { stripeAccount: acct } : undefined
    ),
    [acct]
  )
}

function CheckoutForm({ paymentIntentId }: { paymentIntentId: string }) {
  const stripe = useStripe()
  const elements = useElements()
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return
    setBusy(true)

    const { error: submitErr } = await elements.submit()
    if (submitErr) {
      toast({ title: 'Input error', description: submitErr.message, variant: 'destructive' })
      setBusy(false); return
    }

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${location.origin}/payment-success?payment_intent=${paymentIntentId}` },
      redirect: 'if_required',
    })

    if (error) {
      toast({ title: 'Payment failed', description: error.message, variant: 'destructive' })
    } else if (paymentIntent?.status === 'succeeded') {
      router.push(`/payment-success?payment_intent=${paymentIntent.id}`)
    }
    setBusy(false)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <PaymentElement />
      <Button disabled={!stripe || busy} className="w-full">
        {busy ? 'Processing…' : 'Complete Payment'}
      </Button>
    </form>
  )
}

export default function CheckoutPage() {
  const [clientSecret,    setClientSecret]    = useState('')
  const [paymentIntentId, setPaymentIntentId] = useState('')
  const [stripeAcct,      setStripeAcct]      = useState<string | null>(null)

  const params = useSearchParams()
  const listingId = params.get('listingId')

  const stripePromise = useStripeLoader(stripeAcct)

  useEffect(() => {
    if (!listingId) return

    ;(async () => {
      try {
        console.log('[checkout] creating PI for listing', listingId)
        const res = await fetch('/api/create-payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listingId }),
        })

        if (!res.ok) {
          console.error('[create-payment-intent]', await res.text())
          return
        }

        const { clientSecret, paymentIntentId, stripeAccount } = await res.json()
        console.log('[checkout] PI', paymentIntentId, 'acct', stripeAccount ?? 'platform')
        setClientSecret(clientSecret)
        setPaymentIntentId(paymentIntentId)
        setStripeAcct(stripeAccount) // null -> platform, acct_... -> connected account
      } catch (e) {
        console.error('[checkout] failed to create PI', e)
      }
    })()
  }, [listingId])

  const options = clientSecret
    ? { clientSecret, appearance: { theme: 'stripe' as const } }
    : undefined

  return (
<div className="flex items-center justify-center min-h-screen">
  <div className="container mx-auto max-w-2xl px-4 py-8">
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl text-center">
          Complete Your Purchase
        </CardTitle>
      </CardHeader>
      <CardContent>
        {clientSecret && options ? (
          <Elements
            stripe={stripePromise}
            options={options}
            key={clientSecret}
          >
            <CheckoutForm paymentIntentId={paymentIntentId} />
          </Elements>
        ) : (
          <p className="text-center py-12">Loading payment form…</p>
        )}
      </CardContent>
    </Card>
  </div>
</div>

  )
}
