import { useState, type CSSProperties } from 'react';
import type { CalendarEvent } from '../lib/types';
import { SchoolMark } from './SchoolMark';
import { Sheet } from './Sheet';

type Cover = CalendarEvent['cover'];

// Sampling is optional: remote images without CORS still render on the paper mat.
function imageTone(img: HTMLImageElement): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 12;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, 12, 12);
    const pixels = ctx.getImageData(0, 0, 12, 12).data;
    const rgb = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) rgb[c] = rgb[c]! + pixels[i + c]!;
    return `rgb(${rgb.map(v => Math.round(v / 144)).join(' ')})`;
  } catch { return; }
}

/** Preserve the complete artwork, including lettering near a poster's edges.
 * State is tied to the source so a replacement image gets a fresh load attempt. */
export function ClassArtwork({ cover, name, variant = 'card' }: {
  cover?: Cover; name: string; variant?: 'card' | 'hero' | 'full';
}) {
  const [loaded, setLoaded] = useState<{ url: string; ratio: number; failed: boolean; width?: number; tone?: string }>();
  const current = loaded?.url === cover?.url ? loaded : undefined;
  const ratio = current?.ratio ?? 4 / 3;
  const hasImage = Boolean(cover && !current?.failed);
  const small = Boolean(current?.width && current.width < 720);
  const tone = [...name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 4;
  return <div
    className={`class-artwork class-artwork-${variant} ${hasImage ? 'has-image' : `card-paper-${tone}`} ${ratio < 1 ? 'is-portrait' : ''} ${small ? 'is-small-image' : ''}`}
    style={{
      ...(variant === 'card' && hasImage ? { aspectRatio: Math.min(1.6, Math.max(.6, ratio)) } : {}),
      ...(current?.tone ? { '--artwork-tone': current.tone } : {}),
      ...(small ? { '--artwork-width': `${Math.max(240, current!.width! * 1.5)}px` } : {}),
    } as CSSProperties}
  >
    {hasImage && cover ? <img
      src={cover.url} alt={cover.alt} loading={variant === 'card' ? 'lazy' : 'eager'}
      fetchPriority={variant === 'hero' ? 'high' : 'auto'} decoding="async"
      onLoad={e => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        if (naturalWidth && naturalHeight) setLoaded({ url: cover.url, ratio: naturalWidth / naturalHeight, width: naturalWidth, tone: imageTone(e.currentTarget), failed: false });
      }}
      onError={() => setLoaded({ url: cover.url, ratio: 4 / 3, failed: true })}
    /> : <div className="card-poster" aria-hidden="true"><SchoolMark /><span>{name}</span><small>A little knowledge.<br />A lot to share.</small></div>}
  </div>;
}

export function ClassHero({ cover, name }: { cover?: Cover; name: string }) {
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  return <>
    <figure className="class-hero">
      {cover ? <button type="button" className="class-hero-open" onClick={() => { setZoomed(false); setOpen(true); }} aria-label={`View full image for ${name}`}>
        <ClassArtwork cover={cover} name={name} variant="hero" />
        <span className="artwork-open-label">View full image <span aria-hidden="true">↗</span></span>
      </button> : <ClassArtwork name={name} variant="hero" />}
    </figure>
    {cover ? <Sheet open={open} onClose={() => setOpen(false)} title={name} panelClassName={`artwork-viewer ${zoomed ? 'is-zoomed' : ''}`}>
      {open ? <><div className="artwork-viewer-tools"><button type="button" aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>{zoomed ? 'Fit image' : 'Zoom in'}</button><span>{zoomed ? 'Scroll to explore the details' : 'The whole image, just as it was shared'}</span></div>
      <ClassArtwork cover={cover} name={name} variant="full" />
      {cover.alt ? <p className="artwork-caption">{cover.alt}</p> : null}</> : null}
    </Sheet> : null}
  </>;
}
