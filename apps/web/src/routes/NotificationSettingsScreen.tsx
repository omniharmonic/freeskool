import { LoadingState, PageState } from '../components/PageState';
import { useState } from 'react';
import { Screen } from '../components/Screen';
import { Button } from '../components/bits';
import { SessionGate } from '../components/SessionGate';
import { useInstallFlow } from '../components/InstallNudge';
import { canRequestPush } from '../lib/ios-install';
import { ApiError } from '../lib/api';
import {
  useNewsletterSubscription,
  useNotificationPrefs,
  useSetNewsletterMutation,
  useSetNotificationPrefsMutation,
} from '../lib/queries';
import type { NotificationPref } from '../lib/types';

const CATEGORY_LABEL: Record<string, string> = {
  'event.reminder': "Reminders for classes you're going to",
  'event.changed': "When a class you're going to changes",
  'event.cancelled': "When a class you're going to is cancelled",
  'rsvp.promoted': 'When a place opens up for you',
  'rsvp.received': 'When someone RSVPs to a class you host',
  'offering.published': 'New classes posted',
  'member.joined': 'When someone new joins',
  'feedback.received': 'Feedback on a class you taught',
  'request.asked-of': 'When someone asks you to teach something',
};

/**
 * ROUTE MODEL: the brief asks for a per-category choice of `off` / `inbox` /
 * `push` / `email`. The backend only ever stores two independent booleans
 * per category (`PUT /api/notifications/prefs`'s `{category, transport:
 * 'web-push'|'email', enabled}[]`, `apps/appview/src/notifications/
 * dispatch.ts`), and the in-app feed row itself is written UNCONDITIONALLY
 * on every notification (`enqueueNotification`) — there is no way to turn
 * it off from here. A distinct `off` state would therefore be identical,
 * on the wire, to `inbox`: nothing to disable differently. Rather than
 * offer a fourth option that does nothing a third doesn't already do, this
 * screen offers three: Inbox (the floor — always on), Push, and Email. See
 * the Task 6 report for this gap.
 */
type Route = 'inbox' | 'push' | 'email';

function routeFor(category: string, prefs: NotificationPref[]): Route {
  const push = prefs.find((p) => p.category === category && p.transport === 'web-push');
  const email = prefs.find((p) => p.category === category && p.transport === 'email');
  if (push?.enabled) return 'push';
  if (email?.enabled) return 'email';
  return 'inbox';
}

export function NotificationSettingsScreen() {
  return (
    <SessionGate screen prompt="Sign in to change your notification settings.">
      <NotificationSettingsForm />
    </SessionGate>
  );
}

function NotificationSettingsForm() {
  const { surface, permission, remindersOn, turnOnReminders, openInstallSheet } = useInstallFlow();
  const { data: prefsData, isPending, isError, refetch } = useNotificationPrefs();
  const setPrefsMutation = useSetNotificationPrefsMutation();
  const { data: newsletter, isPending: newsletterPending, isError: newsletterLoadError, refetch: refetchNewsletter } = useNewsletterSubscription();
  const setNewsletterMutation = useSetNewsletterMutation();
  const [newsletterError, setNewsletterError] = useState<string | null>(null);

  const categories = prefsData?.categories ?? [];
  const prefs = prefsData?.prefs ?? [];

  const installState =
    surface === 'installed'
      ? remindersOn || permission === 'granted'
        ? 'On'
        : permission === 'denied'
          ? 'Turned off in iOS Settings'
          : 'Not asked yet'
      : "Not installed — push only works once you add Free School to your Home Screen";

  const setRoute = (category: string, route: Route) => {
    const next: NotificationPref[] = [
      { category, transport: 'web-push', enabled: route === 'push' },
      { category, transport: 'email', enabled: route === 'email' },
    ];
    setPrefsMutation.mutate(next);
  };

  const onToggleNewsletter = async (subscribed: boolean) => {
    setNewsletterError(null);
    try {
      await setNewsletterMutation.mutateAsync({ subscribed });
    } catch (err) {
      setNewsletterError(
        err instanceof ApiError && err.code === 'NoEmailOnFile'
          ? "This sign-in has no email on file, so there's nowhere to send it."
          : 'Could not change that. Try again.',
      );
    }
  };

  return (
    <Screen title="Notifications" layout="form" standfirst="Stay in the loop, on your terms. Choose where class updates find you." back>
      <div className="safe-x">
        <div className="plate p-3.5">
          <p className="text-body">Reminders on this device</p>
          <p className="mt-1 text-caption text-ink-soft">{installState}</p>
          {surface === 'installed' ? (
            <div className="mt-3">
              <Button ink="blue" onClick={() => void turnOnReminders()}>
                Turn on reminders
              </Button>
            </div>
          ) : (
            <div className="mt-3">
              <Button ink="blue" onClick={openInstallSheet}>
                Add to Home Screen first
              </Button>
            </div>
          )}
        </div>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">By category</h2>
        {isPending ? <LoadingState label="Loading your notification choices…" /> : null}
        {isError ? <PageState title="Your preferences couldn’t load." error action={<button className="primary-action" onClick={() => void refetch()}>Try again</button>} /> : null}
        {setPrefsMutation.isError ? <p role="alert">Could not save that notification choice. Try again.</p> : null}
        {setPrefsMutation.isSuccess ? <p role="status" className="mb-3 text-caption text-green">Notification choice saved.</p> : null}
        <ul className="settings-list">
          {categories.map((category) => {
            const route = routeFor(category, prefs);
            return (
              <li key={category}>
                <p className="text-body">{CATEGORY_LABEL[category] ?? category}</p>
                <div className="settings-routes" role="group" aria-label={`Route for ${category}`}>
                  {(['inbox', 'push', 'email'] as Route[]).map((option) => {
                    const disabled = option === 'push' && !canRequestPush();
                    const active = route === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        disabled={disabled || setPrefsMutation.isPending}
                        aria-pressed={active}
                        onClick={() => setRoute(category, option)}
                        className="border-[1.5px] border-ink px-3 py-1.5 text-caption font-medium capitalize disabled:opacity-40"
                        style={{
                          background: active ? 'var(--c-ink)' : 'transparent',
                          color: active ? 'var(--c-paper-2)' : 'var(--c-ink)',
                        }}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
                {route === 'inbox' ? (
                  <p className="mt-1.5 text-caption text-ink-faint">
                    You'll still see this on the Calendar and in the app — just no push or email.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">Monthly newsletter</h2>
        <div className="plate flex items-center justify-between gap-4 p-3.5">
          <span className="min-w-0">
            <span className="block text-body">Email digest</span>
            <span className="block text-caption text-ink-soft">
              {newsletter?.subscribed ? "You're subscribed." : 'Classes and news, once a month.'}
            </span>
          </span>
          <Button
            ink={newsletter?.subscribed ? 'ink' : 'blue'}
            variant={newsletter?.subscribed ? 'quiet' : 'solid'}
            disabled={setNewsletterMutation.isPending || newsletterPending || newsletterLoadError}
            onClick={() => void onToggleNewsletter(!newsletter?.subscribed)}
          >
            {newsletter?.subscribed ? 'Unsubscribe' : 'Subscribe'}
          </Button>
        </div>
        {newsletterLoadError ? <PageState title="Your subscription couldn’t load." error action={<Button onClick={() => void refetchNewsletter()}>Try again</Button>} /> : null}
        {newsletterError ? <p role="alert" className="mt-2 text-body text-pink">{newsletterError}</p> : null}
      </div>
    </Screen>
  );
}
