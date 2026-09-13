import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { normalizeImage } from '../src/lib/images.js'

describe('member images', () => {
  it('strips source metadata and bounds output dimensions', async () => {
    const original = await sharp({ create: { width: 3200, height: 1600, channels: 3, background: '#558866' } })
      .withMetadata({ exif: { IFD0: { Artist: 'private photographer', Copyright: 'private location' } } }).jpeg().toBuffer()
    const result = await normalizeImage({ data: `data:image/jpeg;base64,${original.toString('base64')}`, alt: ' A green garden ' })
    const metadata = await sharp(Buffer.from(result.data, 'base64')).metadata()
    expect(metadata.width).toBe(2400)
    expect(metadata.height).toBe(1200)
    expect(metadata.format).toBe('webp')
    expect(metadata.exif).toBeUndefined()
    expect(metadata.xmp).toBeUndefined()
    expect(result.alt).toBe('A green garden')
  })
  it('preserves small images without inventing larger pixels', async () => {
    const original = await sharp({ create: { width: 240, height: 135, channels: 3, background: '#558866' } }).jpeg().toBuffer()
    const result = await normalizeImage({ data: `data:image/jpeg;base64,${original.toString('base64')}`, alt: 'A small snapshot' })
    const metadata = await sharp(Buffer.from(result.data, 'base64')).metadata()
    expect([metadata.width, metadata.height]).toEqual([240, 135])
  })
  it('rejects scripts, SVG and mislabeled binary data', async () => {
    for (const data of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,bm90LWFuLWltYWdl', 'https://example.com/photo.jpg']) {
      await expect(normalizeImage({ data, alt: '' })).rejects.toMatchObject({ status: 400, code: 'InvalidImage' })
    }
  })
  it('makes avatars square without retaining the original', async () => {
    const original = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#558866' } }).png().toBuffer()
    const result = await normalizeImage({ data: `data:image/png;base64,${original.toString('base64')}`, alt: '' }, true)
    const metadata = await sharp(Buffer.from(result.data, 'base64')).metadata()
    expect([metadata.width, metadata.height]).toEqual([384, 384])
  })
})
