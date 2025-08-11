'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Search, Grid, List } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'

type ListingRow = {
  id: string
  title: string
  description: string | null
  image_url: string | null
  price_cents: number
  currency: string
  seller_id: string
  buyer_id: string | null
  status: 'listed' | 'sold' | 'inactive'
  is_active: boolean
  created_at: string | null
}

function dollars(cents: number) {
  return (cents / 100).toFixed(2)
}

/* ───────────────────────────── Card ───────────────────────────── */

function MarketplaceCard({
  listing,
  currentUserId,
  onCancel,
}: {
  listing: ListingRow
  currentUserId: string | null
  onCancel: (l: ListingRow) => Promise<void>
}) {
  const isSoldOrInactive = listing.status !== 'listed' || !listing.is_active
  const isSeller = !!currentUserId && currentUserId === listing.seller_id
  const priceUSD = Number(listing.price_cents) / 100

  return (
    <Card className="group hover:shadow-xl transition-all duration-300 transform hover:-translate-y-1">
      <CardContent className="p-0">
        <div className="relative overflow-hidden rounded-t-lg">
          <Image
            src={listing.image_url || '/placeholder.svg'}
            alt={listing.title}
            width={800}
            height={600}
            className="w-full h-64 object-cover group-hover:scale-105 transition-transform duration-300"
            priority
          />
          <Badge className={`absolute top-2 left-2 ${isSoldOrInactive ? 'bg-red-600' : 'bg-green-600'}`}>
            {isSoldOrInactive ? 'Unavailable' : 'Available'}
          </Badge>
        </div>

        <div className="p-4">
          <h3 className="font-bold text-lg mb-1 line-clamp-1">{listing.title}</h3>
          {listing.description && (
            <p className="text-sm text-muted-foreground mb-1 line-clamp-2">{listing.description}</p>
          )}
          <div className="flex items-center justify-between mt-3">
            <span className="text-2xl font-bold text-green-600">${priceUSD.toFixed(2)}</span>

            {/* Seller sees "Cancel listing"; others see "Buy Now" */}
            {isSeller ? (
              <Button
                size="sm"
                variant="destructive"
                className="min-w-[120px]"
                disabled={isSoldOrInactive}
                onClick={() => onCancel(listing)}
              >
                Cancel listing
              </Button>
            ) : (
              <Link href={`/checkout?listingId=${listing.id}`}>
                <Button size="sm" className="min-w-[120px]" disabled={isSoldOrInactive}>
                  Buy&nbsp;Now
                </Button>
              </Link>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────── Filters ─────────────────────────── */

function FilterSidebar({
  minPrice,
  maxPrice,
  setMinPrice,
  setMaxPrice,
  applyFilters,
}: {
  minPrice: string
  maxPrice: string
  setMinPrice: (v: string) => void
  setMaxPrice: (v: string) => void
  applyFilters: () => void
}) {
  return (
    <div className="w-full lg:w-64 space-y-6">
      <Card>
        <CardContent className="p-4">
          <h3 className="font-semibold mb-4">Filters</h3>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Price Range (USD)</label>
              <div className="flex gap-2">
                <Input placeholder="Min" type="number" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
                <Input placeholder="Max" type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
              </div>
            </div>
            <Button className="w-full" onClick={applyFilters}>
              Apply Filters
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/* ───────────────────────────── Page ───────────────────────────── */

export default function MarketplacePage() {
  const supabase: SupabaseClient = createClientComponentClient()
  const { toast } = useToast()

  const [uid, setUid] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [listings, setListings] = useState<ListingRow[]>([])

  // filters / query UI
  const [q, setQ] = useState('')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [sort, setSort] = useState<'price-low' | 'price-high' | 'newest' | undefined>()

  // resolve session
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!mounted) return
      setUid(session?.user?.id ?? null)
    })()
    return () => {
      mounted = false
    }
  }, [supabase])

  const loadListings = useCallback(async () => {
    setLoading(true)

    // Base query: only active market items
    let query = supabase
      .from('mkt_listings')
      .select('id,title,description,image_url,price_cents,currency,seller_id,buyer_id,status,is_active,created_at')
      .eq('status', 'listed')
      .eq('is_active', true)

    // Text search against title/description (simple ilike)
    if (q.trim()) {
      const like = `%${q.trim()}%`
      query = query.or(`title.ilike.${like},description.ilike.${like}`)
    }

    // Sort
    if (sort === 'price-low') query = query.order('price_cents', { ascending: true })
    else if (sort === 'price-high') query = query.order('price_cents', { ascending: false })
    else if (sort === 'newest') query = query.order('created_at', { ascending: false })
    else query = query.order('created_at', { ascending: false })

    const { data, error } = await query.returns<ListingRow[]>()

    if (error) {
      console.error('loadListings error:', error.message)
      setListings([])
      setLoading(false)
      return
    }

    // Client-side price filter in USD
    let rows = data ?? []
    if (minPrice) rows = rows.filter((r) => r.price_cents >= Math.round(Number(minPrice) * 100))
    if (maxPrice) rows = rows.filter((r) => r.price_cents <= Math.round(Number(maxPrice) * 100))

    setListings(rows)
    setLoading(false)
  }, [supabase, q, sort, minPrice, maxPrice])

  useEffect(() => {
    loadListings()
  }, [loadListings])

  const resultsText = useMemo(() => {
    if (loading) return 'Loading…'
    const n = listings.length
    return `${n} item${n === 1 ? '' : 's'} found`
  }, [loading, listings.length])

  // seller-only action
  const cancelListing = useCallback(
    async (listing: ListingRow) => {
      // lightweight guard
      if (!uid || uid !== listing.seller_id) {
        toast({ title: 'Unable to cancel', description: 'Only the seller can cancel this listing.', variant: 'destructive' })
        return
      }

      const { error } = await supabase
        .from('mkt_listings')
        .update({ status: 'inactive', is_active: false })
        .eq('id', listing.id)
        .eq('seller_id', uid) // reinforce ownership in query

      if (error) {
        toast({ title: 'Cancel failed', description: error.message, variant: 'destructive' })
        return
      }

      // Optimistic UI
      setListings((prev) => prev.filter((r) => r.id !== listing.id))
      toast({ title: 'Listing canceled', description: `${listing.title} removed from marketplace.` })
    },
    [supabase, uid, toast]
  )

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-4">Marketplace</h1>
        <p className="text-xl text-gray-600">Discover and purchase amazing cards</p>
      </div>

      {/* Search + Sort */}
      <div className="flex flex-col lg:flex-row gap-4 mb-8">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-5 w-5" />
          <Input
            placeholder="Search listings…"
            className="pl-10 h-12"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadListings()}
          />
        </div>
        <div className="flex gap-2">
          <Select onValueChange={(v) => setSort(v as any)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="price-low">Price: Low → High</SelectItem>
              <SelectItem value="price-high">Price: High → Low</SelectItem>
              <SelectItem value="newest">Newest First</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon">
            <Grid className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon">
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-col lg:flex-row gap-8">
        <FilterSidebar
          minPrice={minPrice}
          maxPrice={maxPrice}
          setMinPrice={setMinPrice}
          setMaxPrice={setMaxPrice}
          applyFilters={loadListings}
        />

        <div className="flex-1">
          <p className="text-gray-600 mb-4">{resultsText}</p>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="animate-pulse h-96 bg-gray-200 rounded" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {listings.map((row) => (
                <MarketplaceCard key={row.id} listing={row} currentUserId={uid} onCancel={cancelListing} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
