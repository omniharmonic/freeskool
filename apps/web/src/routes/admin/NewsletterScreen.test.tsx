import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// jsdom has no `<dialog>` showModal/close, and the send confirmation is a Sheet.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
}

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  useRouterState: vi.fn(() => '/admin/newsletter'),
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, _code: string | undefined, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    api: {
      auth: { me: vi.fn() },
      admin: { newsletter: { compose: vi.fn(), send: vi.fn(), last: vi.fn() }, skills: { proposals: vi.fn() } },
    },
    ApiError,
  };
});

const { api } = await import('../../lib/api');
const { NewsletterScreen } = await import('./NewsletterScreen');

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewsletterScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.auth.me).mockReset().mockResolvedValue({
    did: 'did:plc:steward',
    kind: 'custodial',
    role: 40,
    isCustodial: true,
    emailVerified: true,
    onboarded: true,
  });
  vi.mocked(api.admin.newsletter.compose).mockReset().mockResolvedValue({
    id: 'iss1',
    month: '2026-09',
    subject: 'September at Boulder Free School',
    body: 'Eleven classes this month.',
    text: 'Eleven classes this month.',
    html: '<p>Eleven classes this month.</p>',
    status: 'draft',
  });
  vi.mocked(api.admin.newsletter.send).mockReset().mockResolvedValue({ ok: true, recipientCount: 12 });
  vi.mocked(api.admin.newsletter.last).mockReset().mockResolvedValue({ issue: null });
});

describe('NewsletterScreen', () => {
  it('shows the preview section before anything is composed, and says where the words come from', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByText('Nothing to preview yet.')).toBeInTheDocument();
    expect(screen.getByText(/writes the digest from that month’s listed classes/i)).toBeInTheDocument();
    // …and the help line under the heading says it is not a blank composer.
    expect(screen.getByText(/not composing anything by hand/i)).toBeInTheDocument();
  });

  it('fills the same section with the draft it generated, without a second click', async () => {
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Compose draft' }));

    await waitFor(() => expect(screen.getByLabelText('Newsletter preview')).toHaveValue('Eleven classes this month.'));
    expect(screen.getByText('September at Boulder Free School')).toBeInTheDocument();
    expect(screen.queryByText('Nothing to preview yet.')).not.toBeInTheDocument();
  });

  it('shows the last issue in the Preview section before anything is composed this session', async () => {
    vi.mocked(api.admin.newsletter.last).mockResolvedValue({
      issue: {
        id: 'iss0',
        month: '2026-08',
        status: 'sent',
        sentAt: '2026-08-01T00:00:00Z',
        recipientCount: 9,
        html: '<p>August classes.</p>',
        text: 'August classes.',
      },
    });
    renderScreen();

    expect(await screen.findByLabelText('Last newsletter')).toHaveValue('August classes.');
    expect(screen.getByText(/last sent/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-08/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing to preview yet.')).not.toBeInTheDocument();
  });

  it('a freshly composed draft replaces the last-issue preview, not the other way round', async () => {
    vi.mocked(api.admin.newsletter.last).mockResolvedValue({
      issue: { id: 'iss0', month: '2026-08', status: 'sent', sentAt: null, recipientCount: 9, html: '<p>x</p>', text: 'August classes.' },
    });
    renderScreen();
    await screen.findByLabelText('Last newsletter');

    fireEvent.click(await screen.findByRole('button', { name: 'Compose draft' }));

    await waitFor(() => expect(screen.getByLabelText('Newsletter preview')).toHaveValue('Eleven classes this month.'));
    expect(screen.queryByLabelText('Last newsletter')).not.toBeInTheDocument();
  });

  it('never says who the subscribers are, before or after sending', async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Compose draft' }));
    await screen.findByLabelText('Newsletter preview');

    fireEvent.click(screen.getByRole('button', { name: 'Send to subscribers' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/reached 12 subscribers/i)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('did:');
  });
});
