import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

const SKILL_ID = 'at://did:plc:school/freeschool.draft.skill/de-escalation';

vi.mock('@tanstack/react-router', () => ({
  useParams: vi.fn(() => ({ skillId: SKILL_ID })),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  Link: ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../lib/api', () => ({
  api: { skills: { get: vi.fn() }, requests: { list: vi.fn() } },
}));

const { api } = await import('../lib/api');
const { SkillScreen } = await import('./SkillScreen');

const tierBSkill = {
  uri: SKILL_ID,
  id: 'de-escalation',
  label: 'De-escalation',
  status: 'canonical' as const,
  tier: 'B' as const,
  prerequisites: [],
  ancestors: [],
  children: [],
  taughtIn: [],
};

const tierASkill = {
  ...tierBSkill,
  uri: 'at://did:plc:school/freeschool.draft.skill/bread',
  id: 'bread',
  label: 'Bread baking',
  tier: 'A' as const,
};

const proposedSkill = {
  ...tierASkill,
  uri: 'at://did:plc:school/freeschool.draft.skill/beekeeping',
  id: 'beekeeping',
  label: 'Beekeeping',
  status: 'proposed' as const,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillScreen />
    </QueryClientProvider>,
  );
}

describe('SkillScreen', () => {
  it('shows the "Sensitive" marker for a Tier B skill', async () => {
    vi.mocked(api.skills.get).mockReset().mockResolvedValue(tierBSkill);
    vi.mocked(api.requests.list).mockReset().mockResolvedValue({ requests: [] });
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'De-escalation' })).toBeInTheDocument();
    expect(screen.getByText(/sensitive/i)).toBeInTheDocument();
  });

  it('shows no marker for a Tier A skill', async () => {
    vi.mocked(api.skills.get).mockReset().mockResolvedValue(tierASkill);
    vi.mocked(api.requests.list).mockReset().mockResolvedValue({ requests: [] });
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Bread baking' })).toBeInTheDocument();
    expect(screen.queryByText(/sensitive/i)).not.toBeInTheDocument();
  });

  it('shows a muted "proposed" marker for a proposed skill', async () => {
    vi.mocked(api.skills.get).mockReset().mockResolvedValue(proposedSkill);
    vi.mocked(api.requests.list).mockReset().mockResolvedValue({ requests: [] });
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Beekeeping' })).toBeInTheDocument();
    expect(screen.getByText('proposed')).toBeInTheDocument();
  });

  it('shows no "proposed" marker for a canonical skill', async () => {
    vi.mocked(api.skills.get).mockReset().mockResolvedValue(tierASkill);
    vi.mocked(api.requests.list).mockReset().mockResolvedValue({ requests: [] });
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Bread baking' })).toBeInTheDocument();
    expect(screen.queryByText('proposed')).not.toBeInTheDocument();
  });
});
