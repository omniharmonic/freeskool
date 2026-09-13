import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ClassArtwork, ClassHero } from './ClassArtwork';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => vi.restoreAllMocks());
const cover = { url: '/poster.webp', alt: 'A mushroom workshop flyer' };

describe('class artwork', () => {
  it('recovers from a failed image when the host replaces it', () => {
    const { rerender } = render(<ClassArtwork cover={cover} name="Grow together" />);
    fireEvent.error(screen.getByAltText(cover.alt));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Grow together')).toBeInTheDocument();
    rerender(<ClassArtwork cover={{ ...cover, url: '/replacement.webp' }} name="Grow together" />);
    expect(screen.getByAltText(cover.alt)).toHaveAttribute('src', '/replacement.webp');
  });
  it('keeps small images distinguishable from full-resolution portraits', () => {
    const { container } = render(<ClassArtwork cover={cover} name="Grow together" variant="hero" />);
    const img = screen.getByAltText(cover.alt);
    Object.defineProperties(img, { naturalWidth: { value: 240 }, naturalHeight: { value: 135 } });
    fireEvent.load(img);
    expect(container.firstChild).toHaveClass('is-small-image');
    expect(img).toHaveAttribute('fetchpriority', 'high');
    expect(img).toHaveAttribute('loading', 'eager');
  });
  it('loads the enlarged artwork only when opened and supports Escape dismissal', () => {
    render(<ClassHero cover={cover} name="Grow together" />);
    expect(screen.getAllByAltText(cover.alt)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'View full image for Grow together' }));
    expect(screen.getByRole('dialog', { name: 'Grow together' })).toBeVisible();
    expect(screen.getAllByAltText(cover.alt)).toHaveLength(2);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByAltText(cover.alt)).toHaveLength(1);
  });
});
