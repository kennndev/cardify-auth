'use client'
import { Suspense } from 'react'
import useSWR from 'swr'
import { useSearchParams } from 'next/navigation'

function PaymentSuccessContent() {
  const params = useSearchParams()
  const id = params.get('payment_intent')

  const { data, error } = useSWR(id ? `/api/payment-intent/${id}` : null,
    (url) => fetch(url).then(r => r.json()))

  if (error) return <p className="text-red-600">Error: {error.message}</p>
  if (!data)  return <p>Loading…</p>

  return (
    <div className="max-w-md mx-auto mt-24 text-center space-y-4">
      <h1 className="text-2xl font-bold">Payment&nbsp;{data.intent.status}</h1>
      <p>Amount: ${(data.intent.amount_received/100).toFixed(2)}</p>
      <p>Payment&nbsp;Intent: {data.intent.id}</p>
      {data.tx.seller_acct
        ? <p>Funds sent to seller account <code>{data.tx.seller_acct}</code></p>
        : <p>Funds captured by platform</p>}
    </div>
  )
}

export default function PaymentSuccess() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <PaymentSuccessContent />
    </Suspense>
  )
}