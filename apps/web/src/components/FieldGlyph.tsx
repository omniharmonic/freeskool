/** Small workshop drawings for library categories, independent of any invented activity. */
export function FieldGlyph({ seed = '', className = '' }: { seed?: string; className?: string }) {
  const n = [...seed].reduce((total, char) => total + char.charCodeAt(0), 0) % 5;
  return <svg className={`field-glyph ${className}`} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {n === 0 ? <><circle cx="32" cy="32" r="23"/><path d="M9 32h46M32 9v46M16 16l32 32m0-32L16 48"/><circle cx="32" cy="32" r="10"/></> :
      n === 1 ? <><path d="M12 46 32 12l20 34H12Zm10 0 10-18 10 18M32 12v40M8 52h48"/><circle cx="32" cy="28" r="3"/></> :
      n === 2 ? <><path d="M32 55V25M32 40C8 41 9 17 9 17s24-1 23 23Zm0-10C55 30 54 9 54 9S33 8 32 30ZM13 21l19 19m17-26L32 30M23 55h18"/></> :
      n === 3 ? <><path d="M9 15c9-3 16-1 23 4 7-5 14-7 23-4v34c-9-3-16-1-23 4-7-5-14-7-23-4V15Zm23 4v34M16 24l10 3m-10 7 10 3m12-10 10-3m-10 13 10-3"/></> :
      <><circle cx="22" cy="23" r="10"/><circle cx="42" cy="23" r="10"/><path d="M8 53c0-14 6-20 14-20s14 6 14 20m-8 0c0-14 6-20 14-20s14 6 14 20M22 13v20m20-20v20"/></>}
  </svg>;
}
