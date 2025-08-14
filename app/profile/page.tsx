// app/profile/page.tsx
"use client"

export const dynamic = "force-dynamic"

import { useEffect, useMemo, useState, useCallback } from "react"
import Image from "next/image"
import Link from "next/link"
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { useOwnedCardify } from "@/hooks/useOwnedCardify"
import NFTCard from "@/components/NFTCard"
import { WalletButton } from "@/components/WalletConnect"
import AvatarUploader from "@/components/AvatarUploader"

const FACTORY = process.env.NEXT_PUBLIC_FACTORY_ADDRESS as `0x${string}`

type AssetRow = {
  id: string
  owner_id: string
  title: string | null
  image_url: string | null
  storage_path: string | null
  mime_type: string | null
  size_bytes: number | null
  created_at: string | null
}

type UIAsset = {
  id: string
  owner_id: string
  file_path: string
  file_name: string
  file_size: number | null
  mime_type: string | null
  uploaded_at: string | null
  public_url: string
}

const toUI = (row: AssetRow): UIAsset => {
  const file_path = row.storage_path ?? row.title ?? ""
  const file_name = (row.title && row.title.trim()) || file_path.split("/").pop() || "file"
  return {
    id: row.id,
    owner_id: row.owner_id,
    file_path,
    file_name,
    file_size: row.size_bytes ?? null,
    mime_type: row.mime_type ?? null,
    uploaded_at: row.created_at ?? null,
    public_url: row.image_url ?? "",
  }
}

type ListingRow = {
  id: string
  source_id: string
  seller_id: string
  status: "listed" | "sold" | "inactive"
  is_active: boolean
  price_cents: number
}

export default function Profile() {
  const supabase = createClientComponentClient()
  const { toast } = useToast()

  const [onboarding, setOnboarding] = useState(false)
  const [uid, setUid] = useState<string | null>(null)
  const [loadingAuth, setLoadingAuth] = useState(true)

  const [assets, setAssets] = useState<UIAsset[]>([])
  const [loadingAssets, setLoadingAssets] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [stripeVerified, setStripeVerified] = useState<boolean | null>(null)
  const [stripeAccount, setStripeAccount] = useState<string | null>(null)

  // SELL dialog (fixed $9.00)
  const [sellOpen, setSellOpen] = useState(false)
  const [selectedAsset, setSelectedAsset] = useState<UIAsset | null>(null)
  const FIXED_PRICE_USD = 9
  const [creating, setCreating] = useState(false)

  const [listingBySource, setListingBySource] = useState<Record<string, ListingRow | undefined>>({})
  const [canceling, setCanceling] = useState<string | null>(null)

  const PAGE_SIZE = 24
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  const canSell = Boolean(stripeAccount && stripeVerified)
  const totalMb = useMemo(
    () => assets.reduce((s, a) => s + (a.file_size ?? 0) / (1024 * 1024), 0),
    [assets]
  )

  // Avatar (driven by AvatarUploader)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

  async function fetchSellerListings(userId: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      setListingBySource({})
      return
    }
    const { data, error } = await supabase
      .from("mkt_listings")
      .select("id, source_id, seller_id, status, is_active, price_cents")
      .eq("seller_id", userId)
      .eq("source_type", "asset")
      .in("source_id", assetIds)
      .eq("status", "listed")
      .eq("is_active", true)
      .returns<ListingRow[]>()
    if (error) {
      console.error(error)
      setListingBySource({})
      return
    }
    const map: Record<string, ListingRow> = {}
    for (const row of data ?? []) map[row.source_id] = row
    setListingBySource(map)
  }

  useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoadingAuth(true)
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const id = session?.user?.id ?? null
      if (!mounted) return

      if (!id) {
        setUid(null)
        setAvatarUrl(null)
        setLoadingAuth(false)
        setAssets([])
        setHasMore(false)
        setLoadingAssets(false)
        const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
          if (s?.user?.id) {
            setUid(s.user.id)
            setAvatarUrl(s.user.user_metadata?.avatar_url || null)
            fetchFirstPage(s.user.id)
            fetchStripeStatus(s.user.id)
          }
        })
        return () => sub.subscription.unsubscribe()
      }

      setUid(id)
      setAvatarUrl(session?.user?.user_metadata?.avatar_url || null)
      setLoadingAuth(false)
      await Promise.all([fetchFirstPage(id), fetchStripeStatus(id)])
    })()

    async function fetchFirstPage(userId: string) {
      setLoadingAssets(true)
      setLoadError(null)
      const { data, error } = await supabase
        .from("user_assets")
        .select("id, owner_id, title, image_url, storage_path, mime_type, size_bytes, created_at")
        .eq("owner_id", userId)
        .order("created_at", { ascending: false })
        .range(0, PAGE_SIZE - 1)
        .returns<AssetRow[]>()
      if (error) {
        setLoadError(error.message)
        setAssets([])
        setHasMore(false)
      } else {
        const mapped = (data ?? []).map(toUI)
        setAssets(mapped)
        setOffset(mapped.length)
        setHasMore((data?.length ?? 0) === PAGE_SIZE)
        await fetchSellerListings(userId, mapped.map((a) => a.id))
      }
      setLoadingAssets(false)
    }

    async function fetchStripeStatus(userId: string) {
      const { data, error } = await supabase
        .from("mkt_profiles")
        .select("stripe_verified, stripe_account_id")
        .eq("id", userId)
        .single()
      if (!error && data) {
        setStripeVerified(!!data.stripe_verified)
        setStripeAccount(data.stripe_account_id ?? null)
      } else {
        setStripeVerified(false)
        setStripeAccount(null)
      }
    }

    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const signInWithGoogle = async () => {
    const origin = window.location.origin
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/profile")}` },
    })
  }

  const loadMore = useCallback(async () => {
    if (!uid || loadingMore) return
    setLoadingMore(true)
    const from = offset,
      to = offset + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from("user_assets")
      .select("id, owner_id, title, image_url, storage_path, mime_type, size_bytes, created_at")
      .eq("owner_id", uid)
      .order("created_at", { ascending: false })
      .range(from, to)
      .returns<AssetRow[]>()
    if (!error) {
      const mapped = (data ?? []).map(toUI)
      setAssets((prev) => {
        const next = [...prev, ...mapped]
        fetchSellerListings(uid, next.map((a) => a.id))
        return next
      })
      setOffset((prev) => prev + mapped.length)
      setHasMore(mapped.length === PAGE_SIZE)
    }
    setLoadingMore(false)
  }, [uid, offset, supabase, loadingMore])

  useEffect(() => {
    if (!uid) return
    const ch = supabase
      .channel("user-assets-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "user_assets", filter: `owner_id=eq.${uid}` },
        (payload) => {
          const ui = toUI(payload.new as AssetRow)
          setAssets((prev) => {
            const next = [ui, ...prev]
            fetchSellerListings(uid, next.map((a) => a.id))
            return next
          })
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "user_assets", filter: `owner_id=eq.${uid}` },
        (payload) => {
          const ui = toUI(payload.new as AssetRow)
          setAssets((prev) => {
            const idx = prev.findIndex((a) => a.id === ui.id)
            const next = idx >= 0 ? [...prev.slice(0, idx), ui, ...prev.slice(idx + 1)] : [ui, ...prev]
            fetchSellerListings(uid, next.map((a) => a.id))
            return next
          })
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [supabase, uid])

  // On-chain NFTs
  const owned = useOwnedCardify(FACTORY)
  const nftLoading = owned.loading
  const tokens = owned.tokens ?? []

  // SELL: fixed $9
  const openSell = (a: UIAsset) => {
    setSelectedAsset(a)
    setSellOpen(true)
  }

  const createListing = async () => {
    if (!uid || !selectedAsset) return
    if (!canSell) {
      toast({
        title: "Stripe account required",
        description: "Connect Stripe to list items for sale.",
        variant: "destructive",
      })
      return
    }
    setCreating(true)
    const { data, error } = await supabase
      .from("mkt_listings")
      .insert({
        title: selectedAsset.file_name,
        image_url: selectedAsset.public_url,
        price_cents: FIXED_PRICE_USD * 100, // $9
        seller_id: uid,
        status: "listed",
        is_active: true,
        source_type: "asset",
        source_id: selectedAsset.id,
      })
      .select("id, source_id, seller_id, status, is_active, price_cents")
      .returns<ListingRow[]>()
    setCreating(false)
    if (error) {
      toast({ title: "Listing failed", description: error.message, variant: "destructive" })
      return
    }
    const row = data?.[0]
    if (row) setListingBySource((prev) => ({ ...prev, [row.source_id]: row }))
    toast({ title: "Listed for sale", description: `${selectedAsset.file_name} • $${FIXED_PRICE_USD}.00` })
    setSellOpen(false)
    setSelectedAsset(null)
  }

  const cancelListing = async (listing: ListingRow) => {
    if (!uid) return
    setCanceling(listing.id)
    const { error } = await supabase
      .from("mkt_listings")
      .update({ status: "inactive", is_active: false })
      .eq("id", listing.id)
    setCanceling(null)
    if (error) {
      toast({ title: "Cancel failed", description: error.message, variant: "destructive" })
      return
    }
    setListingBySource((prev) => {
      const next = { ...prev }
      delete next[listing.source_id]
      return next
    })
    toast({ title: "Listing canceled" })
  }

  return (
    <div className="min-h-screen bg-cyber-black relative overflow-hidden font-mono">
      <div className="fixed inset-0 cyber-grid opacity-10 pointer-events-none" />
      <div className="fixed inset-0 scanlines opacity-20 pointer-events-none" />

      <div className="px-6 py-8 pt-24 relative max-w-7xl mx-auto">
        {/* Minimal round avatar */}
        <div className="mb-8">
          {uid && (
            <AvatarUploader
              uid={uid}
              initialUrl={avatarUrl}
              onUpdated={(url) => setAvatarUrl(url)}
              size={96}
            />
          )}
        </div>

        {/* Header */}
        <div className="mb-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-white tracking-wider">My Cards</h1>
            <p className="text-gray-400">Your uploaded designs and on-chain Cardify NFTs</p>
          </div>
          <div className="flex items-center gap-3">
            {!uid && !loadingAuth ? (
              <Button className="cyber-button" onClick={signInWithGoogle}>
                Sign in with Google
              </Button>
            ) : (
              <Link href="/upload">
                <Button className="cyber-button">Create New Card</Button>
              </Link>
            )}
          </div>
        </div>

        {/* Assets */}
        <section className="mb-14">
          <div className="flex items-end justify-between mb-4">
            <h2 className="text-2xl font-bold text-white tracking-wider">Uploads</h2>
            <div className="text-xs text-gray-400">
              {assets.length > 0 && (
                <span>
                  {assets.length} file{assets.length > 1 ? "s" : ""} • {totalMb.toFixed(2)} MB total
                </span>
              )}
            </div>
          </div>

          {loadingAssets ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="w-full h-64 rounded border border-cyber-cyan/20" />
              ))}
            </div>
          ) : !uid ? (
            <Card className="bg-cyber-dark/60 border border-cyber-cyan/30">
              <CardContent className="p-6 text-center text-gray-400">Sign in to view your uploads.</CardContent>
            </Card>
          ) : assets.length === 0 ? (
            <Card className="bg-cyber-dark/60 border border-cyber-cyan/30">
              <CardContent className="p-6 text-center text-gray-400">
                {loadError ? (
                  <div className="text-cyber-orange">Failed to load uploads: {loadError}</div>
                ) : (
                  <>
                    No uploads found for this account.
                    <div className="text-xs text-gray-500 mt-2">
                      Active user id: <span className="text-cyber-cyan">{uid ?? "—"}</span>
                    </div>
                    <Link href="/upload" className="ml-2 text-cyber-cyan hover:text-cyber-pink underline">
                      Upload artwork
                    </Link>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {assets.map((a) => {
                  const existing = listingBySource[a.id]
                  const listed = !!existing && existing.is_active && existing.status === "listed"
                  return (
                    <Card
                      key={a.id}
                      className="bg-cyber-dark/60 border border-cyber-cyan/30 hover:border-cyber-cyan/60 transition-colors overflow-hidden"
                    >
                      <CardContent className="p-0">
                        <div className="relative">
                          <Image
                            src={a.public_url || "/placeholder.svg"}
                            alt={a.file_name}
                            width={800}
                            height={600}
                            className="w-full h-64 object-cover"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).src = "/placeholder.svg"
                            }}
                          />
                          <Badge className="absolute top-3 left-3 bg-cyber-cyan/20 border border-cyber-cyan/40 text-cyber-cyan">
                            Uploaded
                          </Badge>
                          {listed && (
                            <Badge className="absolute top-3 left-28 bg-green-500/15 border border-green-500/30 text-green-400">
                              Listed
                            </Badge>
                          )}
                          {a.mime_type && (
                            <Badge className="absolute top-3 right-3 bg-cyber-pink/20 border border-cyber-pink/40 text-cyber-pink">
                              {a.mime_type.replace("image/", "").toUpperCase()}
                            </Badge>
                          )}
                        </div>
                        <div className="p-4 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-white font-bold truncate" title={a.file_name}>
                              {a.file_name}
                            </h3>
                            <span className="text-xs text-gray-400">
                              {(a.file_size ? a.file_size / (1024 * 1024) : 0).toFixed(2)} MB
                            </span>
                          </div>
                          <div className="text-xs text-gray-500">
                            {a.uploaded_at ? new Date(a.uploaded_at).toLocaleString() : ""}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 pt-2">
                            {listed ? (
                              <>
                                <Badge className="bg-green-500/15 border border-green-500/30 text-green-400">
                                  ${((existing!.price_cents ?? 0) / 100).toFixed(2)}
                                </Badge>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => cancelListing(existing!)}
                                  disabled={canceling === existing!.id}
                                >
                                  {canceling === existing!.id ? "Canceling…" : "Cancel listing"}
                                </Button>
                                <a href={a.public_url} target="_blank" rel="noopener noreferrer">
                                  <Button variant="outline" size="sm" className="border-cyber-cyan/40 text-cyber-cyan">
                                    Open
                                  </Button>
                                </a>
                              </>
                            ) : (
                              <>
                                <Button className="cyber-button" size="sm" onClick={() => openSell(a)}>
                                  Sell ($9)
                                </Button>
                                <a href={a.public_url} target="_blank" rel="noopener noreferrer">
                                  <Button variant="outline" size="sm" className="border-cyber-cyan/40 text-cyber-cyan">
                                    Open
                                  </Button>
                                </a>
                              </>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
              {hasMore && (
                <div className="flex justify-center mt-6">
                  <Button onClick={loadMore} disabled={loadingMore} className="cyber-button">
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>

        {/* On-chain NFTs */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-white tracking-wider">On-Chain Cardify NFTs</h2>
            <WalletButton />
          </div>
          {nftLoading ? (
            <Card className="bg-cyber-dark/60 border border-cyber-cyan/30">
              <CardContent className="p-6 text-gray-400">Scanning wallet…</CardContent>
            </Card>
          ) : tokens.length === 0 ? (
            <Card className="bg-cyber-dark/60 border border-cyber-cyan/30">
              <CardContent className="p-6 text-gray-400">Connect your wallet to see your Cardify NFTs.</CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-6">
              {tokens.map(([collection, id]) => (
                <NFTCard key={`${collection}-${id}`} collection={collection as `0x${string}`} id={id} />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Sell dialog – price locked to $9 */}
      <Dialog open={sellOpen} onOpenChange={setSellOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>List for Sale</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="text-sm text-gray-400 break-words">{selectedAsset?.file_name}</div>
            <div>
              <label className="block text-sm font-medium">Price (USD)</label>
              <Input value={FIXED_PRICE_USD.toFixed(2)} disabled className="bg-gray-900/40" />
              {!canSell && (
                <div className="mt-2 text-xs text-cyber-orange">
                  Stripe not connected. Connect your account to list items.
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button variant="outline" onClick={() => setSellOpen(false)}>
              Close
            </Button>
            {canSell ? (
              <Button onClick={createListing} disabled={creating} className="cyber-button">
                {creating ? "Listing…" : "List for $9"}
              </Button>
            ) : (
              <Button
                onClick={async () => {
                  try {
                    setOnboarding(true)
                    const res = await fetch("/api/stripe/onboard", { method: "POST" })
                    const json = await res.json()
                    if (!res.ok || (!json?.url && !json?.dashboardUrl)) {
                      toast({
                        title: "Stripe onboarding failed",
                        description: json?.error || "Try again.",
                        variant: "destructive",
                      })
                      return
                    }
                    window.location.href = json.url ?? json.dashboardUrl
                  } finally {
                    setOnboarding(false)
                  }
                }}
                disabled={onboarding}
                className="cyber-button"
              >
                {onboarding ? "Opening…" : "Connect Stripe"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
