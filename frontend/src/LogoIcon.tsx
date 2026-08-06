export function LogoIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Outer subtle orbital ring */}
      <circle 
        cx="12" 
        cy="12" 
        r="9.5" 
        stroke="currentColor" 
        strokeWidth="1.5" 
        strokeOpacity="0.3" 
      />
      {/* Pane / Node grid representation */}
      <rect 
        x="7.5" 
        y="7.5" 
        width="9" 
        height="9" 
        rx="2" 
        stroke="currentColor" 
        strokeWidth="1.75" 
      />
      {/* Internal active node indicator */}
      <circle 
        cx="12" 
        cy="12" 
        r="2" 
        fill="var(--accent-color, #3b82f6)" 
      />
      {/* Orbit node dot */}
      <circle 
        cx="18.5" 
        cy="7" 
        r="1.75" 
        fill="var(--accent-color, #3b82f6)" 
      />
    </svg>
  )
}
