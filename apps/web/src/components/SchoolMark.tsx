/** A small geodesic meeting place: a structure held up by many connections. */
export function SchoolMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 120 120" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
      <path d="M60 8 105 34 105 86 60 112 15 86 15 34Z" />
      <path d="m60 8 22 39 23-13-23 39 23 13-45-1v27L38 73 15 86l23-39-23-13 45 1V8Z" />
      <path d="m60 35 22 12v26L60 85 38 73V47Z M15 34l45 51 45-51M15 86 60 35l45 51M60 8v104M38 47h44M38 73h44" />
    </g>
    <g fill="currentColor">{[[60,8],[105,34],[105,86],[60,112],[15,86],[15,34],[60,35],[82,47],[82,73],[60,85],[38,73],[38,47]].map(([cx,cy],i)=><circle key={i} cx={cx} cy={cy} r="2.2" />)}</g>
  </svg>;
}
