// lib/upload.ts
"use client"

import { getSupabaseBrowserClient } from "./supabase-browser"

const mimeToExt: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}

export async function uploadToSupabase(file: Blob | File, customPath?: string) {
  const supabase = getSupabaseBrowserClient()

  // Require a real session (no anonymous)
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user?.id) throw new Error("Not signed in")

  const userId = session.user.id
  const userEmail = session.user.email ?? null

  const name = (file as File).name || "uploaded"
  const mime = (file as File).type || "application/octet-stream"
  const extFromMime = mimeToExt[mime]
  const extFromName = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
  const ext = (extFromMime || extFromName || "bin").replace(/[^a-z0-9]/g, "")

  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`
  const safeCustom = (customPath || "").replace(/^\/+/, "").replace(/\.\./g, "")
  const baseDir = `uploads/${userId}`
  const storagePath = safeCustom ? `${baseDir}/${safeCustom}/${fileName}` : `${baseDir}/${fileName}`

  console.log("📤 Uploading:", { storagePath, mime, size: (file as File).size })

  const { error: uploadError } = await supabase
    .storage
    .from("custom-uploads")
    .upload(storagePath, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: mime,
    })
  if (uploadError) throw uploadError

  const { data: { publicUrl } } = supabase
    .storage
    .from("custom-uploads")
    .getPublicUrl(storagePath)

  const { data: imageRecord, error: dbError } = await supabase
    .from("uploaded_images")
    .insert({
      image_url: publicUrl,
      storage_path: storagePath,
      file_size_bytes: (file as File).size ?? null,
      file_type: mime,
      user_email: userEmail,
      user_id: userId,
      metadata: {
        original_filename: name,
        upload_source: "custom_card_upload",
        timestamp: new Date().toISOString(),
      },
    })
    .select()
    .single()

  if (dbError) console.warn("DB insert failed (upload ok):", dbError)

  return { publicUrl, storagePath, imageRecordId: imageRecord?.id ?? null }
}
