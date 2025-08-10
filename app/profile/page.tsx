// app/profile/page.tsx
"use client"

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

const FACTORY = process.env.NEXT_PUBLIC_FACTORY_ADDRESS as `0x${string}`

type UploadedImageRow = {
  id: string; user_id: string; storage_path: string; image_url: string;
  file_size_bytes: number | null; file_type: string | null; created_at: string | null
}
type UIUpload = {
  id: string; user_id: string; file_path: string; file_name: string; file_size: number | null;
  mime_type: string | null; uploaded_at: string | null; public_url: string
}
const toUI = (row: UploadedImageRow): UIUpload => {
  const file_path = row.storage_path
  const file_name = file_path.split("/").pop() || "file"
  return {
    id: row.id, user_id: row.user_id, file_path, file_name,
    file_size: row.file_size_bytes ?? null, mime_type: row.file_type ?? null,
    uploaded_at: row.created_at ?? null, public_url: row.image_url,
  }
}

export default function Profile() {
  const supabase = createClientComponentClient()
  const { toast } = useToast()
const [onboarding, setOnboarding] = useState(false)
  const [uid, setUid] = useState<string | null>(null)
  const [loadingAuth, setLoadingAuth] = useState(true)
  const [uploads, setUploads] = useState<UIUpload[]>([])
  const [loadingUploads, setLoadingUploads] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // seller/stripe status
  const [stripeVerified, setStripeVerified] = useState<boolean | null>(null)
  const [stripeAccount, setStripeAccount] = useState<string | null>(null)

  // sell dialog
  const [sellOpen, setSellOpen] = useState(false)
  const [selectedUpload, setSelectedUpload] = useState<UIUpload | null>(null)
  const [price, setPrice] = useState<string>("")
  const [creating, setCreating] = useState(false)

  const PAGE_SIZE = 24
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  // ---- resolve session, then fetch
  useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoadingAuth(true)
      const { data: { session } } = await supabase.auth.getSession()
      const id = session?.user?.id ?? null
      if (!mounted) return

      if (!id) {
        setUid(null)
        setLoadingAuth(false)
        setUploads([])
        setHasMore(false)
        setLoadingUploads(false)
        const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
          if (s?.user?.id) {
            setUid(s.user.id)
            fetchFirstPage(s.user.id)
            fetchStripeStatus(s.user.id)
          }
        })
        return () => sub.subscription.unsubscribe()
      }

      setUid(id)
      setLoadingAuth(false)
      await Promise.all([fetchFirstPage(id), fetchStripeStatus(id)])
    })()

    async function fetchFirstPage(userId: string) {
      setLoadingUploads(true)
      setLoadError(null)
      const { data, error } = await supabase
        .from("uploaded_images")
        .select("id,user_id,storage_path,image_url,file_size_bytes,file_type,created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(0, PAGE_SIZE - 1)
        .returns<UploadedImageRow[]>()
      if (error) {
        setLoadError(error.message)
        setUploads([]); setHasMore(false)
      } else {
        const mapped = (data ?? []).map(toUI)
        setUploads(mapped)
        setOffset(mapped.length)
        setHasMore((data?.length ?? 0) === PAGE_SIZE)
      }
      setLoadingUploads(false)
    }



    async function fetchStripeStatus(userId: string) {
      // read marketplace profile
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

    return () => { mounted = false }
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
    const from = offset, to = offset + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from("uploaded_images")
      .select("id,user_id,storage_path,image_url,file_size_bytes,file_type,created_at")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .range(from, to)
      .returns<UploadedImageRow[]>()
    if (!error) {
      const mapped = (data ?? []).map(toUI)
      setUploads(prev => [...prev, ...mapped])
      setOffset(prev => prev + mapped.length)
      setHasMore(mapped.length === PAGE_SIZE)
    }
    setLoadingMore(false)
  }, [uid, offset, supabase, loadingMore])

  // realtime: new uploads
  useEffect(() => {
    if (!uid) return
    const ch = supabase
      .channel("uploads-feed")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "uploaded_images", filter: `user_id=eq.${uid}` },
        (payload) => setUploads(prev => [toUI(payload.new as UploadedImageRow), ...prev]),
      )
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [supabase, uid])

  const { tokens, loading: nftLoading } = useOwnedCardify(FACTORY)
  const totalMb = useMemo(() => uploads.reduce((s, u) => s + ((u.file_size ?? 0) / (1024 * 1024)), 0), [uploads])

  // ───────────── sell flow ─────────────
  const openSell = (u: UIUpload) => {
    setSelectedUpload(u)
    setPrice("")
    setSellOpen(true)
  }

  const createListing = async () => {
    if (!uid || !selectedUpload) return
    const priceNum = Number(price)
    if (!priceNum || isNaN(priceNum) || priceNum <= 0) {
      toast({ title: "Enter a valid price (USD)", variant: "destructive" })
      return
    }
    if (!stripeVerified) {
      toast({
        title: "Stripe account required",
        description: "Connect Stripe to list items for sale.",
        variant: "destructive",
      })
      // optional redirect to your connect page
      // window.location.href = "/connect-stripe"
      return
    }

    setCreating(true)
    // Insert into marketplace listings; RLS should enforce seller_id + stripe_verified
    const { error } = await supabase
      .from("mkt_listings")
      .insert({
        title: selectedUpload.file_name,
        image_url: selectedUpload.public_url,
        storage_path: selectedUpload.file_path,
        price_cents: Math.round(priceNum * 100),
        seller_id: uid,
        status: "listed",
        is_active: true,
        source_type: "uploaded_image",
        source_id: selectedUpload.id,
      })

    setCreating(false)
    if (error) {
      toast({ title: "Listing failed", description: error.message, variant: "destructive" })
      return
    }

    toast({ title: "Listed for sale", description: selectedUpload.file_name })
    setSellOpen(false)
    setSelectedUpload(null)
  }

const connectStripe = useCallback(async () => {
  try {
    setOnboarding(true)
    const res = await fetch('/api/stripe/onboard', { method: 'POST' })
    const json = await res.json()
    if (!res.ok || !json?.url) {
      toast({
        title: 'Stripe onboarding failed',
        description: json?.error || 'Try again.',
        variant: 'destructive',
      })
      return
    }
    window.location.href = json.url
  } finally {
    setOnboarding(false)
  }
}, [toast])

  return (
    <div className="min-h-screen bg-cyber-black relative overflow-hidden font-mono">
      <div className="fixed inset-0 cyber-grid opacity-10 pointer-events-none" />
      <div className="fixed inset-0 scanlines opacity-20 pointer-events-none" />

      <div className="px-6 py-8 pt-24 relative max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-white tracking-wider">My Cards</h1>
            <p className="text-gray-400">Your uploaded designs and on-chain Cardify NFTs</p>
          </div>
          <div className="flex items-center gap-3">
            {!uid && !loadingAuth ? (
              <Button className="cyber-button" onClick={signInWithGoogle}>Sign in with Google</Button>
            ) : (
              <Link href="/upload"><Button className="cyber-button">Create New Card</Button></Link>
            )}
          </div>
        </div>

        {/* Uploads */}
        <section className="mb-14">
          <div className="flex items-end justify-between mb-4">
            <h2 className="text-2xl font-bold text-white tracking-wider">Uploads</h2>
            <div className="text-xs text-gray-400">
              {uploads.length > 0 && <span>{uploads.length} file{uploads.length > 1 ? "s" : ""} • {totalMb.toFixed(2)} MB total</span>}
            </div>
          </div>

          {loadingUploads ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="w-full h-64 rounded border border-cyber-cyan/20" />)}
            </div>
          ) : !uid ? (
            <Card className="bg-cyber-dark/60 border border-cyber-cyan/30">
              <CardContent className="p-6 text-center text-gray-400">Sign in to view your uploads.</CardContent>
            </Card>
          ) : uploads.length === 0 ? (
            <Card className="bg-cyber-dark/60 border border-cyber-cyan/30">
              <CardContent className="p-6 text-center text-gray-400">
                {loadError ? (
                  <div className="text-cyber-orange">Failed to load uploads: {loadError}</div>
                ) : (
                  <>
                    No uploads found for this account.
                    <div className="text-xs text-gray-500 mt-2">Active user id: <span className="text-cyber-cyan">{uid ?? "—"}</span></div>
                    <Link href="/upload" className="ml-2 text-cyber-cyan hover:text-cyber-pink underline">Upload artwork</Link>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {uploads.map(u => (
                  <Card key={u.id} className="bg-cyber-dark/60 border border-cyber-cyan/30 hover:border-cyber-cyan/60 transition-colors overflow-hidden">
                    <CardContent className="p-0">
                      <div className="relative">
                        <Image
                          src={u.public_url || "/placeholder.svg"}
                          alt={u.file_name}
                          width={800} height={600}
                          className="w-full h-64 object-cover"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/placeholder.svg" }}
                        />
                        <Badge className="absolute top-3 left-3 bg-cyber-cyan/20 border border-cyber-cyan/40 text-cyber-cyan">Uploaded</Badge>
                        {u.mime_type && (
                          <Badge className="absolute top-3 right-3 bg-cyber-pink/20 border border-cyber-pink/40 text-cyber-pink">
                            {u.mime_type.replace("image/", "").toUpperCase()}
                          </Badge>
                        )}
                      </div>
                      <div className="p-4 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-white font-bold truncate" title={u.file_name}>{u.file_name}</h3>
                          <span className="text-xs text-gray-400">{(u.file_size ? u.file_size / (1024 * 1024) : 0).toFixed(2)} MB</span>
                        </div>
                        <div className="text-xs text-gray-500">{u.uploaded_at ? new Date(u.uploaded_at).toLocaleString() : ""}</div>
                        <div className="flex gap-2 pt-2">
                          {/* REPLACED: Use in Order → Sell */}
                          <Button className="cyber-button" size="sm" onClick={() => openSell(u)}>
                            Sell
                          </Button>
                          <a href={u.public_url} target="_blank" rel="noopener noreferrer">
                            <Button variant="outline" size="sm" className="border-cyber-cyan/40 text-cyber-cyan">
                              Open
                            </Button>
                          </a>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
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
              <CardContent className="p-6 text-gray-400">Scanning wallet on Base-Sepolia…</CardContent>
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

      {/* Sell Dialog */}
      <Dialog open={sellOpen} onOpenChange={setSellOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>List for Sale</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="text-sm text-gray-400 break-words">
              {selectedUpload?.file_name}
            </div>
            <div>
              <label htmlFor="sell-price" className="block text-sm font-medium">Price (USD)</label>
              <Input
                id="sell-price"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="e.g. 19.99"
              />
              {stripeVerified === false && (
                <div className="mt-2 text-xs text-cyber-orange">
                  Stripe not connected. Connect your account to list items.
                </div>
              )}
            </div>
          </div>
<DialogFooter className="pt-2">
  <Button variant="outline" onClick={() => setSellOpen(false)}>Cancel</Button>

  {stripeVerified ? (
    <Button onClick={createListing} disabled={creating} className="cyber-button">
      {creating ? "Listing…" : "List"}
    </Button>
  ) : (
    <Button onClick={connectStripe} disabled={onboarding} className="cyber-button">
      {onboarding ? "Opening…" : "Connect Stripe"}
    </Button>
  )}
</DialogFooter>

        </DialogContent>
      </Dialog>
    </div>
  )
}
