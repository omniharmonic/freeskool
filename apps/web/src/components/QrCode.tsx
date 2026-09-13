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
 * screen is fail silently into a blank square — so a failed draw swaps the
 * canvas for a visible fallback line pointing back at the link itself.
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

  if (failed) {
    return <p className="text-caption text-ink-soft">QR unavailable — use the link</p>;
  }
  return <canvas ref={ref} width={size} height={size} role="img" aria-label="QR code for this link" />;
}
