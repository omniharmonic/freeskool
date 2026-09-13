import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A small pure-JS QR code, rendered to canvas. No network call — `qrcode`
 * generates the matrix locally, which matters for a hand-off link: the link
 * itself is a one-time steward credential and must never leave this device
 * via a third-party QR-rendering service.
 *
 * B5: `toCanvas` can reject (no 2D context available, a browser quirk, …),
 * and the one thing this must never do on a one-time steward credential
 * screen is fail silently into a blank square — so a failed draw shows a
 * visible fallback line pointing back at the link itself.
 *
 * R2: the canvas stays MOUNTED (merely `hidden`) even after a failed draw,
 * rather than being swapped out for the fallback text. Unmounting it clears
 * `ref.current`, so a later `value` change reran this effect against a null
 * ref and silently drew nothing — the component was then stuck showing the
 * fallback forever, even once a good value came in. Keeping the canvas
 * mounted means the next draw always has somewhere to land.
 */
export function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const canvas = ref.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, value, { width: size, margin: 1 }).catch(() => setFailed(true));
  }, [value, size]);

  return (
    <>
      <canvas ref={ref} width={size} height={size} role="img" aria-label="QR code for this link" hidden={failed} />
      {failed ? <p className="text-caption text-ink-soft">QR unavailable — use the link</p> : null}
    </>
  );
}
