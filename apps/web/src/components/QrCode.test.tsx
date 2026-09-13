import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QrCode } from './QrCode';

/**
 * B5: a QR draw failure must never leave a steward staring at a blank
 * canvas for a one-time hand-off link — there has to be a visible fallback
 * line pointing back at the link itself. jsdom has no real canvas backend
 * (`HTMLCanvasElement.getContext` is "not implemented"), which is exactly
 * the failure this component has to handle, so no mocking is needed: the
 * `qrcode` library's draw call rejects here the same way a real canvas
 * failure would in the browser.
 */
describe('QrCode', () => {
  it('shows the fallback line instead of a blank canvas when drawing fails', async () => {
    render(<QrCode value="https://example.org/account/reveal/tok123" />);

    expect(await screen.findByText('QR unavailable — use the link')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'QR code for this link' })).not.toBeInTheDocument();
  });
});
