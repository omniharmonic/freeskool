import { useRef, useState } from 'react';
import type { ImageInput } from '../lib/types';

/** Keep the original off the network: resize in-browser, then re-encode again on the server. */
export function ImagePicker({ value, existingUrl, onChange, avatar = false }: {
  value?: ImageInput | null; existingUrl?: string; onChange: (value: ImageInput | null) => void; avatar?: boolean;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const preview = value === null ? undefined : value?.data ?? existingUrl;
  async function choose(file?: File) {
    if (!file) return;
    setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setError('Choose a JPEG, PNG or WebP image under 8 MB.'); return;
    }
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, (avatar ? 768 : 2400) / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error();
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
      onChange({ data: canvas.toDataURL('image/jpeg', 0.85), alt: value?.alt ?? '' });
    } catch { setError('This image could not be opened. Try another photo.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return <div className={`image-picker ${avatar ? 'image-picker-avatar' : ''}`}>
    {preview ? <img src={preview} alt={value?.alt || (avatar ? 'Your profile image' : 'Class cover preview')} /> : null}
    <div className="image-picker-controls">
      <label className="upload-button">
        <span>{busy ? 'Preparing image…' : preview ? 'Change image' : avatar ? 'Add a profile image' : 'Add a photo or poster'}</span>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy}
          aria-label={avatar ? 'Profile image' : 'Class cover image'} onChange={e => void choose(e.target.files?.[0])} />
      </label>
      {preview ? <button type="button" className="text-caption text-blue" onClick={() => onChange(null)}>Remove image</button> : null}
    </div>
    {value ? <label className="block mt-3"><span className="text-caption text-ink-soft">Image description{avatar ? ' (optional)' : ''}</span>
      <input className="mt-1 w-full border border-rule rounded-lg bg-sheet px-3 py-2" value={value.alt} maxLength={300}
        required={!avatar} onChange={e => onChange({ ...value, alt: e.target.value })} placeholder="Describe the image for someone who cannot see it" /></label> : null}
    <p className="mt-2 text-caption text-ink-soft">{avatar ? 'Visible only in your account.' : 'Make it yours: a photo, a flyer, a drawing. Portraits and posters are shown in full. Use an image you have permission to share.'} Location metadata is removed.</p>
    {error ? <p role="alert" className="mt-2 text-caption text-pink">{error}</p> : null}
  </div>;
}
