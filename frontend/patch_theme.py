with open('src/index.css', 'r') as f:
    css = f.read()

# Replace variables to look more like Linear/Vercel
# Linear uses deep grays like #0E0E10 or #000000, and border colors like #27272A or #333336
# The primary accent can stay somewhat purple or blue, but very solid, not heavily gradient.

replacements = {
    "--bg-primary: #0B0B12;": "--bg-primary: #0E0E10;",
    "--bg-secondary: #13131F;": "--bg-secondary: #141417;",
    "--bg-surface: #13131F;": "--bg-surface: #18181B;",
    "--bg-surface-hover: rgba(255, 255, 255, 0.06);": "--bg-surface-hover: rgba(255, 255, 255, 0.04);",
    "--bg-card: #1A1A2D;": "--bg-card: #1C1C1F;",
    "--border-color: rgba(255, 255, 255, 0.09);": "--border-color: rgba(255, 255, 255, 0.08);",
    "--border-subtle: rgba(255, 255, 255, 0.06);": "--border-subtle: rgba(255, 255, 255, 0.04);",
    "--brand-gradient: linear-gradient(135deg, #6366F1 0%, #8B5CF6 50%, #EC4899 100%);": "--brand-gradient: linear-gradient(135deg, #5E6AD2 0%, #7663EB 100%);",
    "--text-gradient: linear-gradient(135deg, #FFFFFF 0%, #E2E8F0 40%, #A5B4FC 80%, #C084FC 100%);": "--text-gradient: #FFFFFF;",
    "--shadow-glow: 0 0 16px rgba(139, 92, 246, 0.15);": "--shadow-glow: none;",
    "--border-glow: rgba(139, 92, 246, 0.3);": "--border-glow: rgba(255, 255, 255, 0.1);",
    "--radius-sm: 8px;": "--radius-sm: 6px;",
    "--radius-md: 12px;": "--radius-md: 8px;",
    "--radius-lg: 16px;": "--radius-lg: 12px;",
}

for old, new in replacements.items():
    css = css.replace(old, new)

with open('src/index.css', 'w') as f:
    f.write(css)

