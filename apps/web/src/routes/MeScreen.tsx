import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { LEVEL_LABEL, profile } from '../lib/mock';
import { applyPrefs, readPrefs, writePrefs, type ThemeChoice } from '../lib/prefs';
import { Screen } from '../components/Screen';
import { Button, LevelDots, SkillChip, Toggle } from '../components/bits';
import { useInstallFlow } from '../components/InstallNudge';
import { signOut } from '../lib/api';

export function MeScreen() {
  const [prefs, setPrefs] = useState(readPrefs);
  const { surface, permission, remindersOn, turnOnReminders, openInstallSheet } = useInstallFlow();
  const navigate = useNavigate();

  useEffect(() => {
    applyPrefs(prefs);
    writePrefs(prefs);
  }, [prefs]);

  const notificationState =
    surface !== 'installed'
      ? 'Off — iPhone only sends these from apps on your Home Screen'
      : remindersOn || permission === 'granted'
        ? 'On for the classes you RSVP to'
        : permission === 'denied'
          ? 'Turned off in iOS Settings'
          : 'Not asked yet';

  return (
    <Screen title="Me" standfirst={profile.bio}>
      <div className="safe-x">
        <div className="plate plate-pink flex items-center gap-3.5 p-4">
          <div
            className="halftone halftone-dense grid h-14 w-14 shrink-0 place-items-center"
            style={{ '--ht': 'var(--c-pink)' } as React.CSSProperties}
          >
            <span className="stamp text-[18px]" style={{ color: 'var(--c-paper-2)' }}>
              WH
            </span>
          </div>
          <div className="min-w-0">
            <p className="display text-lede font-bold">{profile.displayName}</p>
            <p className="text-caption text-ink-soft">{profile.handle}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="plate plate-blue px-3.5 py-3">
            <p className="stamp text-[26px] leading-none">{profile.attendedCount}</p>
            <p className="mt-1 text-caption text-ink-soft">classes attended</p>
          </div>
          <div className="plate plate-green px-3.5 py-3">
            <p className="stamp text-[26px] leading-none">{profile.hostedCount}</p>
            <p className="mt-1 text-caption text-ink-soft">classes taught</p>
          </div>
        </div>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">What you say you can do</h2>
        <ul className="space-y-3">
          {profile.skillClaims.map((claim) => (
            <li key={claim.skill.id} className="plate p-3.5">
              <div className="flex items-start justify-between gap-3">
                <Link to="/skills/$skillId" params={{ skillId: claim.skill.id }} className="min-w-0 flex-1">
                  <p className="text-body">{claim.skill.label}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-caption text-ink-soft">
                    <LevelDots level={claim.level} />
                    {LEVEL_LABEL[claim.level]}
                  </p>
                </Link>
                <span className="shrink-0 text-caption text-ink-faint">
                  {claim.attestations === 0
                    ? 'nobody has vouched yet'
                    : `${claim.attestations} vouched`}
                </span>
              </div>
            </li>
          ))}
        </ul>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">Badges</h2>
        <div className="flex flex-wrap gap-2">
          {profile.badges.map((badge) => (
            <SkillChip key={badge} ink="blue">
              {badge}
            </SkillChip>
          ))}
        </div>
        <p className="mt-2 text-caption text-ink-faint">
          Badges are labels for things you did. They are not points and nothing ranks them.
        </p>

        <h2 className="mt-8 mb-2.5 text-lede font-bold">Settings</h2>
        <div className="plate divide-y-[1.5px] divide-rule">
          <div className="p-3.5">
            <p className="text-body">Appearance</p>
            <div className="mt-2.5 flex gap-1.5" role="group" aria-label="Appearance">
              {(['system', 'light', 'dark'] as ThemeChoice[]).map((choice) => {
                const active = prefs.theme === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => setPrefs({ ...prefs, theme: choice })}
                    aria-pressed={active}
                    className="flex-1 border-[1.5px] border-ink py-1.5 text-caption font-medium capitalize"
                    style={{
                      background: active ? 'var(--c-ink)' : 'transparent',
                      color: active ? 'var(--c-paper-2)' : 'var(--c-ink)',
                    }}
                  >
                    {choice}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 p-3.5">
            <span className="min-w-0">
              <span className="block text-body">Reduce blur</span>
              <span className="block text-caption text-ink-soft">
                Safari has no system setting for this, so it lives here. Frosted bars become solid.
              </span>
            </span>
            <Toggle
              label="Reduce blur"
              checked={prefs.reduceBlur}
              onChange={(reduceBlur) => setPrefs({ ...prefs, reduceBlur })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 p-3.5">
            <span className="min-w-0">
              <span className="block text-body">Reminders</span>
              <span className="block text-caption text-ink-soft">{notificationState}</span>
            </span>
            <button
              type="button"
              onClick={surface === 'installed' ? () => void turnOnReminders() : openInstallSheet}
              className="shrink-0 text-caption font-bold text-blue"
            >
              {surface === 'installed' ? 'Change' : 'How?'}
            </button>
          </div>
        </div>

        <div className="mt-6 mb-2">
          <Button
            wide
            variant="quiet"
            ink="ink"
            onClick={() => {
              void signOut();
              void navigate({ to: '/signin' });
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </Screen>
  );
}
