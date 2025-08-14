"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Image from "next/image"
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs"

type Props = {
  uid: string
  initialUrl?: string | null
  onUpdated?: (url: string | null) => void
  size?: number
}

const FALLBACK_DATA_URL =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="100%" height="100%" fill="%23121a21"/><circle cx="128" cy="96" r="48" fill="%231e2b33"/><rect x="64" y="160" width="128" height="56" rx="28" fill="%231e2b33"/></svg>'

export default function AvatarUploader({ uid, initialUrl, onUpdated, size = 96 }: Props) {
  const supabase = createClientComponentClient()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const bootUrl = useMemo(() => {
    if (!initialUrl) return null
    const sep = initialUrl.includes("?") ? "&" : "?"
    return `${initialUrl}${sep}r=${Date.now()}`
  }, [initialUrl])

  const [url, setUrl] = useState<string | null>(bootUrl)
  const [busy, setBusy] = useState(false)
  const [overlay, setOverlay] = useState(false)

  useEffect(() => {
    if (!initialUrl) return
    const sep = initialUrl.includes("?") ? "&" : "?"
    setUrl(`${initialUrl}${sep}r=${Date.now()}`)
  }, [initialUrl])

  const pickFile = () => fileInputRef.current?.click()

  const cropAndCompress = async (file: File, target = 512): Promise<Blob> => {
    const bmp = await createImageBitmap(file)
    const side = Math.min(bmp.width, bmp.height)
    const sx = Math.floor((bmp.width - side) / 2)
    const sy = Math.floor((bmp.height - side) / 2)
    const canvas = document.createElement("canvas")
    canvas.width = target
    canvas.height = target
    const ctx = canvas.getContext("2d")!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(bmp, sx, sy, side, side, 0, 0, target, target)

    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/webp", 0.9)
    )
    return blob
  }

  const onFile = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith("image/")) return
    if (file.size > 5 * 1024 * 1024) {
      console.error("Avatar too large (>5MB)")
      return
    }
    if (!uid) {
      console.error("No uid; user not authenticated")
      return
    }

    const controller = new AbortController()
    const kill = setTimeout(() => controller.abort(), 30_000) // 30s hard timeout

    try {
      setBusy(true)

      // Make sure session is fresh
      await supabase.auth.refreshSession()

      const blob = await cropAndCompress(file, 512)
      const contentType = blob.type || "image/webp"
      const path = `users/${uid}/avatar.webp`

      console.time("storage.upload(avatar)")
      const { error: upErr } = await supabase.storage
        .from("avatars")
        // @ts-expect-error supabase-js v2 supports upsert in upload options
        .upload(path, blob, { upsert: true, cacheControl: "0", contentType, signal: controller.signal })
      console.timeEnd("storage.upload(avatar)")
      if (upErr) throw upErr

      const { data } = supabase.storage.from("avatars").getPublicUrl(path)
      const publicUrl = data?.publicUrl ? `${data.publicUrl}?v=${Date.now()}` : null
      if (!publicUrl) throw new Error("No public URL returned")

      // Update app profile first (RLS should allow user->own row)
      const { error: profErr } = await supabase
        .from("mkt_profiles")
        .update({ avatar_url: publicUrl })
        .eq("id", uid)
      if (profErr) throw profErr

      // Keep auth metadata in sync (best-effort)
      const { error: metaErr } = await supabase.auth.updateUser({ data: { avatar_url: publicUrl, picture: null } })
      if (metaErr) console.warn("auth.updateUser metadata warning:", metaErr.message)

      setUrl(publicUrl)
      onUpdated?.(publicUrl)
    } catch (e: any) {
      if (e?.name === "AbortError") {
        console.error("Upload timed out after 30s")
      } else {
        console.error("Avatar upload failed:", e?.message ?? e)
      }
    } finally {
      clearTimeout(kill)
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const removeAvatar = async () => {
    if (!uid) return
    const path = `users/${uid}/avatar.webp`
    try {
      setBusy(true)
      await supabase.storage.from("avatars").remove([path])
      await supabase.from("mkt_profiles").update({ avatar_url: null }).eq("id", uid)
      await supabase.auth.updateUser({ data: { avatar_url: null } })
      setUrl(null)
      onUpdated?.(null)
    } catch (e: any) {
      console.error("Remove avatar failed:", e?.message ?? e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="relative group select-none"
      style={{ width: size, height: size }}
      onClick={() => setOverlay(s => !s)}
      onMouseLeave={() => setOverlay(false)}
    >
      <div className="relative rounded-full overflow-hidden border-2 border-cyber-green" style={{ width: size, height: size }}>
        <Image
          src={url || FALLBACK_DATA_URL}
          alt="Profile"
          fill
          sizes={`${size}px`}
          className="object-cover"
          priority
          onError={(e) => {
            // never loop network requests; stick to inline fallback
            (e.currentTarget as any).src = FALLBACK_DATA_URL
          }}
        />
      </div>

      <div
        className={[
          "absolute inset-0 rounded-full bg-black/65 opacity-0",
          "group-hover:opacity-100",
          overlay ? "opacity-100" : "",
          "transition-opacity grid place-items-center",
        ].join(" ")}
      >
        {busy ? (
          <span className="text-xs text-white">Uploading…</span>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); pickFile() }}
              className="px-3 py-1 rounded-full text-xs font-semibold bg-cyber-cyan/20 text-cyber-cyan border border-cyber-cyan/40 hover:bg-cyber-cyan/30"
            >
              Upload photo
            </button>
            {url && (
              <button
                onClick={(e) => { e.stopPropagation(); removeAvatar() }}
                className="px-3 py-1 rounded-full text-xs font-semibold bg-cyber-pink/20 text-cyber-pink border border-cyber-pink/40 hover:bg-cyber-pink/30"
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] || undefined)}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
