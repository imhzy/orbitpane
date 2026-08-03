import re

# Patch App.tsx
with open('src/App.tsx', 'r') as f:
    content = f.read()

# Make isDrawerOpen true by default on desktop
content = re.sub(
    r'const \[isDrawerOpen, setIsDrawerOpen\] = useState\(false\)',
    'const [isDrawerOpen, setIsDrawerOpen] = useState(window.innerWidth >= 1024)',
    content
)

# Add window resize listener for isDrawerOpen
hook_str = """
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 1024) {
        setIsDrawerOpen(true)
      } else {
        setIsDrawerOpen(false)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
"""
content = re.sub(
    r'const \[drawerMode, setDrawerMode\] = useState<\'sessions\' \| \'create\'>\(\'sessions\'\)',
    "const [drawerMode, setDrawerMode] = useState<'sessions' | 'create'>('sessions')\n" + hook_str,
    content
)

# Render Right Panel for Thought
right_panel_str = """
      <div className="right-panel">
        <div className="right-panel-header">
          <span className="right-panel-title">执行上下文</span>
        </div>
        <div className="right-panel-content">
          {activeConv && messages.length > 0 ? (
            <div className="context-card">
              <h4 className="context-card-title">最近执行日志</h4>
              <div className="context-timeline">
                {[...messages].reverse().find(m => m.role === 'agent' && (m.thought || m.isThinking)) ? (
                  <AgentExecutionTimeline 
                    thought={[...messages].reverse().find(m => m.role === 'agent' && (m.thought || m.isThinking))?.thought || ''} 
                    isThinking={!![...messages].reverse().find(m => m.role === 'agent' && (m.thought || m.isThinking))?.isThinking} 
                  />
                ) : (
                  <div className="context-empty">当前没有执行中的任务</div>
                )}
              </div>
            </div>
          ) : (
            <div className="context-empty">选择会话或开始对话以查看上下文</div>
          )}
        </div>
      </div>
"""

# Insert Right Panel before the closing div of app-container
content = re.sub(
    r'    </div>\n  \)\n\}\n$',
    right_panel_str + '    </div>\n  )\n}\n',
    content
)

# Also import AgentExecutionTimeline in App.tsx
if 'AgentExecutionTimeline' not in content:
    content = content.replace("import { ThinkingBlock } from './components/ThinkingBlock'", "import { ThinkingBlock } from './components/ThinkingBlock'\nimport { AgentExecutionTimeline } from './components/AgentExecutionTimeline'")


with open('src/App.tsx', 'w') as f:
    f.write(content)

# Patch App.css
with open('src/App.css', 'r') as f:
    css = f.read()

layout_css = """
/* 3-Column Layout */
@media (min-width: 1024px) {
  .drawer-scrim {
    display: none !important;
  }
  
  .drawer {
    position: static;
    transform: none !important;
    max-width: 320px;
    border-right: 1px solid var(--border-color);
    box-shadow: none;
    flex-shrink: 0;
  }
  
  .chat-header .icon-btn[title="展开工作区菜单"] {
    display: none !important;
  }
  
  .drawer-header .icon-btn:last-child {
    display: none !important;
  }
  
  .chat-main {
    flex: 1;
    min-width: 0;
    border-right: 1px solid var(--border-color);
  }
}

.right-panel {
  display: none;
}

@media (min-width: 1280px) {
  .right-panel {
    display: flex;
    flex-direction: column;
    width: 360px;
    background: var(--bg-surface);
    flex-shrink: 0;
    height: 100%;
  }
  
  .right-panel-header {
    height: 64px;
    padding: 0 20px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-header);
    flex-shrink: 0;
  }
  
  .right-panel-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }
  
  .right-panel-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  
  .context-card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  
  .context-card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }
  
  .context-empty {
    font-size: 13px;
    color: var(--text-tertiary);
    text-align: center;
    padding: 32px 0;
  }
}
"""

css += layout_css

with open('src/App.css', 'w') as f:
    f.write(css)

