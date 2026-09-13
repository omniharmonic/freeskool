import { useRouterState } from '@tanstack/react-router';

/**
 * Stands in for every route this plan registers ahead of the task that
 * builds its real screen (see `router.tsx`). Renders the route itself so
 * it's obvious which placeholder is on screen during manual testing.
 */
export function Placeholder() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <div className="app-scroll safe-top safe-x pb-10">
      <div className="pt-10">
        <p className="stamp text-[13px] text-ink-soft">{pathname}</p>
        <h1 className="mt-2 text-lede font-bold">Coming in a later task</h1>
        <p className="mt-3 max-w-[42ch] text-body text-ink-soft">
          This screen is on the plan but not built yet — coming in a later task.
        </p>
      </div>
    </div>
  );
}
