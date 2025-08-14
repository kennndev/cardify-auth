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
    if (initialUrl) {
      const sep = initialUrl.includes("?") ? "&" : "?"
      setUrl(`${initialUrl}${sep}r=${Date.now()}`)
    }
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
    return await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b as Blob), "image/webp", 0.9)
    )
  }

  const onFile = async (file?: File) => {
    if (!file) return
    if (!file.type.startsWith("image/")) return
    if (file.size > 5 * 1024 * 1024) return

    try {
      setBusy(true)
      const blob = await cropAndCompress(file, 512)
      const path = `users/${uid}/avatar.webp`

      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, blob, { upsert: true, cacheControl: "0", contentType: "image/webp" })
      if (upErr) throw upErr

      const { data } = supabase.storage.from("avatars").getPublicUrl(path)
      const publicUrl = data?.publicUrl ? `${data.publicUrl}?v=${Date.now()}` : null

      // write to app DB
      const { error: profErr } = await supabase
        .from("mkt_profiles")
        .update({ avatar_url: publicUrl })
        .eq("id", uid)
      if (profErr) throw profErr

      // (optional) also keep auth metadata in sync and clear provider picture
      await supabase.auth.updateUser({ data: { avatar_url: publicUrl, picture: null } })

      setUrl(publicUrl)
      onUpdated?.(publicUrl)
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const removeAvatar = async () => {
    try {
      setBusy(true)
      const path = `users/${uid}/avatar.webp`
      await supabase.storage.from("avatars").remove([path])

      await supabase.from("mkt_profiles").update({ avatar_url: null }).eq("id", uid)
      await supabase.auth.updateUser({ data: { avatar_url: null } })

      setUrl(null)
      onUpdated?.(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="relative group select-none"
      style={{ width: size, height: size }}
      onClick={() => setOverlay((s) => !s)}
      onMouseLeave={() => setOverlay(false)}
    >
      <div
        className="relative rounded-full overflow-hidden border-2 border-cyber-green"
        style={{ width: size, height: size }}
      >
        <Image
          src={url || "/default-avatar.png"}
          alt="Profile"
          fill
          sizes={`${size}px`}
          className="object-cover"
          priority
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
              onClick={(e) => {
                e.stopPropagation()
                pickFile()
              }}
              className="px-3 py-1 rounded-full text-xs font-semibold bg-cyber-cyan/20 text-cyber-cyan border border-cyber-cyan/40 hover:bg-cyber-cyan/30"
            >
              Upload photo
            </button>
            {url && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removeAvatar()
                }}
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
