import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children?: ReactNode;
  }) => {
    const href = params ? Object.entries(params).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to) : to;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, code: string | undefined, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return {
    api: { skills: { tree: vi.fn() }, auth: { me: vi.fn() } },
    ApiError,
  };
});

const { api } = await import('../lib/api');
const { SkillsScreen } = await import('./SkillsScreen');

const skillTree = {
  skills: [
    {
      uri: 'at://did:plc:school/freeschool.draft.skill/community-safety',
      id: 'community-safety',
      label: 'Community safety',
      status: 'canonical' as const,
      tier: 'A' as const,
      alsoUnder: [],
      children: [
        {
          uri: 'at://did:plc:school/freeschool.draft.skill/first-aid',
          id: 'first-aid',
          label: 'Basic first aid',
          status: 'canonical' as const,
          tier: 'A' as const,
          alsoUnder: [],
          children: [],
        },
        {
          uri: 'at://did:plc:school/freeschool.draft.skill/de-escalation',
          id: 'de-escalation',
          label: 'De-escalation',
          status: 'canonical' as const,
          tier: 'B' as const,
          alsoUnder: [],
          children: [],
        },
        {
          uri: 'at://did:plc:school/freeschool.draft.skill/beekeeping',
          id: 'beekeeping',
          label: 'Beekeeping',
          status: 'proposed' as const,
          tier: 'A' as const,
          alsoUnder: [],
          children: [],
        },
      ],
    },
  ],
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillsScreen />
    </QueryClientProvider>,
  );
}

describe('SkillsScreen', () => {
  it('shows a "Sensitive" marker on a Tier B skill, and not on a Tier A one', async () => {
    vi.mocked(api.skills.tree).mockReset().mockResolvedValue(skillTree);
    renderScreen();

    // Both labels also appear as the area heading (`<p>`, not the link) in
    // `SkillChildren`, so these are matched by role/name on the `<a>` itself,
    // not by text alone.
    const tierALink = await screen.findByRole('link', { name: 'Basic first aid' });
    const tierBLink = screen.getByRole('link', { name: /De-escalation/ });

    expect(within(tierALink).queryByText('Sensitive')).not.toBeInTheDocument();
    expect(within(tierBLink).getByText('Sensitive')).toBeInTheDocument();
  });
  it('shows a muted "proposed" marker on a proposed skill, and not on a canonical one', async () => {
    vi.mocked(api.skills.tree).mockReset().mockResolvedValue(skillTree);
    renderScreen();

    const canonicalLink = await screen.findByRole('link', { name: 'Basic first aid' });
    const proposedLink = screen.getByRole('link', { name: /Beekeeping/ });

    expect(within(canonicalLink).queryByText('proposed')).not.toBeInTheDocument();
    expect(within(proposedLink).getByText('proposed')).toBeInTheDocument();
  });
  it('finds nested skills and shows a useful no-match state', async () => {
    vi.mocked(api.skills.tree).mockReset().mockResolvedValue(skillTree);
    renderScreen();
    await screen.findByRole('link', { name: 'Basic first aid' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), { target: { value: 'first aid' } });
    expect(screen.getByRole('link', { name: 'Basic first aid' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /De-escalation/ })).not.toBeInTheDocument();
    expect(screen.getByText('1 matching skills')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), { target: { value: 'nomatchhere' } });
    expect(screen.getByText('No skills match that search.')).toBeInTheDocument();
  });

});
