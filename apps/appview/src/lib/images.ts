import sharp from 'sharp'

export interface ImageInput { data: string; alt: string }
export interface StoredImage { data: string; alt: string; revision: string }
export class InvalidImageError extends Error {
  status = 400
  code = 'InvalidImage'
  constructor() { super('Choose a JPEG, PNG or WebP image under 8 MB.') }
}

/** Decode pixels, apply orientation, then re-encode. Never retain EXIF, GPS or filenames. */
export async function normalizeImage(input: ImageInput, avatar = false): Promise<StoredImage> {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(input.data)
  if (!match || input.data.length > 11_200_000) throw new InvalidImageError()
  try {
    const data = await sharp(Buffer.from(match[2]!, 'base64'), { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(avatar ? 384 : 2400, avatar ? 384 : 2400, { fit: avatar ? 'cover' : 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
    return { data: data.toString('base64'), alt: input.alt.trim().slice(0, 300), revision: crypto.randomUUID() }
  } catch { throw new InvalidImageError() }
}
