import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import QRCode from 'qrcode';
import { QrCode } from './QrCode';

// Mocked (rather than relying on jsdom's missing canvas backend) so each test controls
// exactly which draw succeeds and which fails — needed for R2 below, which exercises a
// failed draw followed by a successful one for a new `value`.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn() },
}));

const toCanvas = vi.mocked(QRCode.toCanvas);

describe('QrCode', () => {
  beforeEach(() => {
    toCanvas.mockReset();
  });

  /**
   * B5: a QR draw failure must never leave a steward staring at a blank canvas for a
   * one-time hand-off link — there has to be a visible fallback line pointing back at
   * the link itself.
   */
  it('shows the fallback line instead of a blank canvas when drawing fails', async () => {
    toCanvas.mockRejectedValue(new Error('no 2D context'));
    render(<QrCode value="https://example.org/account/reveal/tok123" />);

    expect(await screen.findByText('QR unavailable — use the link')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'QR code for this link' })).not.toBeInTheDocument();
  });

  /**
   * R2: a failed draw used to unmount the canvas entirely, which cleared `ref.current` —
   * so a later `value` change reran the effect against a null ref and drew nothing,
   * leaving the fallback showing forever even once a good value came in. The canvas now
   * stays mounted (merely `hidden`) so the next draw always has somewhere to land.
   */
  it('redraws once a new value comes in after a failed draw', async () => {
    toCanvas.mockRejectedValueOnce(new Error('no 2D context'));
    toCanvas.mockResolvedValueOnce(undefined);

    const { rerender } = render(<QrCode value="https://example.org/one" />);
    expect(await screen.findByText('QR unavailable — use the link')).toBeInTheDocument();

    rerender(<QrCode value="https://example.org/two" />);

    expect(await screen.findByRole('img', { name: 'QR code for this link' })).toBeInTheDocument();
    expect(screen.queryByText('QR unavailable — use the link')).not.toBeInTheDocument();
    expect(toCanvas).toHaveBeenCalledTimes(2);
  });
});
