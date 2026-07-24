export function LogoIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 512 512" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="logoNeonGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366F1"/>
          <stop offset="50%" stopColor="#8B5CF6"/>
          <stop offset="100%" stopColor="#EC4899"/>
        </linearGradient>

        <linearGradient id="logoSparkleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF"/>
          <stop offset="100%" stopColor="#C084FC"/>
        </linearGradient>

        <linearGradient id="logoAccentGrad" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#06B6D4"/>
          <stop offset="100%" stopColor="#3B82F6"/>
        </linearGradient>

        <filter id="logoFilterGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="12" result="blur"/>
          <feComposite in="SourceGraphic" in2="blur" operator="over"/>
        </filter>
      </defs>

      {/* Outer Ring Orbit */}
      <g transform="translate(256, 256) rotate(-25)">
        <ellipse cx="0" cy="0" rx="190" ry="64" stroke="url(#logoNeonGrad)" strokeWidth="10" strokeOpacity="0.5" fill="none" strokeDasharray="14 14"/>
        <ellipse cx="0" cy="0" rx="190" ry="64" stroke="url(#logoAccentGrad)" strokeWidth="12" strokeLinecap="round" strokeDasharray="90 280" fill="none" filter="url(#logoFilterGlow)"/>
      </g>

      {/* Center Dynamic Star */}
      <g transform="translate(256, 256)">
        <path d="M 0 -135 Q 0 0 -135 0 Q 0 0 0 135 Q 0 0 135 0 Q 0 0 0 -135 Z" fill="url(#logoNeonGrad)" filter="url(#logoFilterGlow)"/>
        <path d="M 0 -85 Q 0 0 -85 0 Q 0 0 0 85 Q 0 0 85 0 Q 0 0 0 -85 Z" fill="url(#logoSparkleGrad)"/>
        <circle cx="-110" cy="-90" r="14" fill="url(#logoSparkleGrad)"/>
        <circle cx="120" cy="80" r="11" fill="url(#logoAccentGrad)"/>
      </g>
    </svg>
  )
}
