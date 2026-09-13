import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

/**
 * A small pure-JS QR code, rendered to canvas. No network call — `qrcode`
 * generates the matrix locally, which matters for a hand-off link: the link
 * itself is a one-time steward credential and must never leave this device
 * via a third-party QR-rendering service.
 */
export function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, value, { width: size, margin: 1 }).catch(() => undefined);
  }, [value, size]);

  return <canvas ref={ref} width={size} height={size} role="img" aria-label="QR code for this link" />;
}
