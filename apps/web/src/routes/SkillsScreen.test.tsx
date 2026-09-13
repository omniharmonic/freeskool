import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

vi.mock('../lib/api', () => ({
  api: { skills: { tree: vi.fn() } },
}));

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
});
