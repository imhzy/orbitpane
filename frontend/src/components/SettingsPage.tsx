import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, Archive, Bell, Bot, Check, ChevronRight, Fingerprint, Folder, Info, LogOut, Monitor, Moon, RefreshCw, Settings, ShieldCheck, ShieldAlert, SlidersHorizontal, Smartphone, Sun, Trash2 } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { useAppContext } from '../contexts/AppContext'
import { useEscapeLayer } from '../hooks/useEscapeLayer'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useUpdateCheck } from '../hooks/useUpdateCheck'
import { apiFetch } from '../lib/api'
import { AUTH_EXPIRED_EVENT } from '../lib/auth'
import { registerPasskey, passkeyError, supportsPasskeys } from '../lib/passkeys'
import { disablePush } from '../lib/push'
import { formatModelName } from '../lib/providers'
import { clearPwaInstallPrompt, getPwaInstallPrompt, subscribeToPwaInstallPrompt } from '../lib/pwaInstall'
import { readJson, writeJson } from '../lib/storage'
import type { ModelOption, ModelsResponse, TaskRecord } from '../lib/types'
import { isTaskActive } from '../lib/taskStatus'
import { PushNotificationButton } from './PushNotificationButton'
import { Input, Select } from './FormControls'
import { ProviderUsageCard } from './ProviderUsage'
import './SettingsPage.css'
import { PluginsSettings } from './ProjectPlugins'

const SECTIONS = [
  { id: 'general', label: '通用', Icon: SlidersHorizontal, description: '让 OrbitPane 更符合你的使用习惯。' },
  { id: 'ai', label: 'AI 与工作区', Icon: Bot, description: '设置新建项目时使用的默认运行配置。' },
  { id: 'plugins', label: 'Agent 插件', Icon: Bot, description: '统一管理全局插件、账号与密钥，启用后所有项目均可使用。' },
  { id: 'notifications', label: '通知', Icon: Bell, description: '选择这台设备如何提醒你任务进展。' },
  { id: 'data', label: '数据管理', Icon: Archive, description: '整理已归档项目与对话记录。' },
  { id: 'security', label: '安全', Icon: ShieldCheck, description: '管理登录方式与当前登录状态。' },
  { id: 'about', label: '关于', Icon: Info, description: '保持应用更新，随时从桌面打开。' },
] as const

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="settings-row"><div className="settings-row-copy"><h3>{title}</h3>{description && <p>{description}</p>}</div><div className="settings-row-control">{children}</div></div>
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h2>{title}</h2><div className="settings-group-body">{children}</div></section>
}

function GeneralSettings() {
  const { preferences, updatePreferences } = useAppContext()
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  return <>
    <SettingsGroup title="外观">
      <div className="settings-theme-grid" role="radiogroup" aria-label="界面主题">
        {([{ id: 'light', label: '浅色', Icon: Sun }, { id: 'dark', label: '深色', Icon: Moon }, { id: 'system', label: '跟随系统', Icon: Monitor }] as const).map(({ id, label, Icon }) => (
          <button key={id} type="button" role="radio" aria-checked={preferences.theme === id}
            className={`settings-theme-choice ${preferences.theme === id ? 'selected' : ''}`} onClick={() => updatePreferences({ theme: id })}>
            <span className={`settings-theme-preview ${id}`} aria-hidden="true"><i /><span><b /><b /><b /></span></span>
            <span className="settings-theme-label"><Icon size={15} />{label}{preferences.theme === id && <Check size={14} />}</span>
          </button>
        ))}
      </div>
    </SettingsGroup>
    <SettingsGroup title="键盘快捷键">
      {[
        ['打开设置', `${modifier} ,`], ['搜索与快捷指令', `${modifier} K`], ['新建项目', `${modifier} ⇧ J`],
        ['展开 / 收起项目列表', `${modifier} B`], ['聚焦消息输入框', `${modifier} /`], ['中断当前任务', `${modifier} .`], ['消息换行', 'Shift Enter'],
      ].map(([label, keys]) => <SettingRow key={label} title={label}><kbd>{keys}</kbd></SettingRow>)}
    </SettingsGroup>
    <p className="settings-footnote">偏好保存在当前浏览器，并即时生效。</p>
  </>
}

function AiSettings() {
  const { preferences, updatePreferences, providers, defaultProvider, serverDefaultProvider, workspaceRoots } = useAppContext()
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const defaultModel = preferences.defaultModels[defaultProvider] || ''
  const currentProvider = providers.find(provider => provider.id === defaultProvider)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(false); setModels([])
    apiFetch<ModelsResponse>(`/api/models?provider=${encodeURIComponent(defaultProvider)}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setModels(data.models); writeJson(`orbitpane_models_${defaultProvider}`, data.models) } })
      .catch(() => {
        if (controller.signal.aborted) return
        const cached = readJson<ModelOption[]>(`orbitpane_models_${defaultProvider}`, [])
        setModels(Array.isArray(cached) ? cached.filter(model => model && typeof model.id === 'string') : [])
        setError(true)
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [defaultProvider, attempt])
  const modelSupported = models.some(model => model.id === defaultModel)
  return <>
    <SettingsGroup title="默认 AI">
      <SettingRow title="默认 Agent" description="用于之后新建的项目。现有项目保留各自的 Agent。">
        <Select className="settings-select" aria-label="默认 Agent" value={preferences.defaultProvider}
          onChange={value => updatePreferences({ defaultProvider: value })}
          options={[{ value: '', label: `服务器默认 · ${providers.find(provider => provider.id === serverDefaultProvider)?.name || serverDefaultProvider}` },
            ...providers.map(provider => ({ value: provider.id, label: `${provider.name}${!provider.available ? '（不可用）' : ''}`, disabled: !provider.available }))]} />
      </SettingRow>
      <SettingRow title="默认模型" description={`新建 ${currentProvider?.name || defaultProvider} 项目时使用；对话中可随时切换。`}>
        <Select className="settings-select" aria-label="默认模型" disabled={loading} value={modelSupported ? defaultModel : ''}
          onChange={value => updatePreferences({ defaultModels: { ...preferences.defaultModels, [defaultProvider]: value } })}
          options={[{ value: '', label: loading ? '正在读取模型…' : 'Agent 默认模型' },
            ...models.map(model => ({ value: model.id, label: model.display_name }))]} />
      </SettingRow>
      {error && <div className="settings-inline-note" role="status">模型列表暂未同步，已显示本机缓存。<button type="button" onClick={() => setAttempt(previous => previous + 1)}>重试</button></div>}
      {!loading && defaultModel && !modelSupported && <p className="settings-inline-note">之前选择的模型目前不可用，新项目将使用 Agent 默认模型。</p>}
      {preferences.defaultProvider && preferences.defaultProvider !== defaultProvider && <p className="settings-inline-note">所选 Agent 目前不可用，新项目将使用服务器默认 Agent。</p>}
    </SettingsGroup>
    <SettingsGroup title="默认工作区">
      <SettingRow title="起始目录" description="创建项目和浏览文件夹时，从这个工作区开始。">
        <Select className="settings-select" aria-label="默认工作区" value={preferences.workspaceRoot}
          onChange={value => updatePreferences({ workspaceRoot: value })}
          options={[{ value: '', label: '服务器默认目录' }, ...workspaceRoots.map(root => ({ value: root, label: root }))]} />
      </SettingRow>
      <SettingRow title="默认文件权限" description="新项目默认使用受限工作区。如需完全访问，在具体项目中确认后开启。"><span className="settings-status"><ShieldCheck size={14} />受限工作区</span></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="Agent 状态">
      {providers.map(provider => <div className="settings-agent-status" key={provider.id}>
        <SettingRow title={provider.name}><span className={`settings-status ${provider.available ? 'available' : ''}`}><i />{provider.available ? '可用' : '不可用'}</span></SettingRow>
        <ProviderUsageCard provider={provider.id} />
      </div>)}
      {providers.length === 0 && <p className="settings-empty">暂未读取到 Agent，请稍后重新打开设置。</p>}
    </SettingsGroup>
    <p className="settings-footnote">默认配置保存在当前浏览器，仅用于之后新建的项目。</p>
  </>
}

function NotificationSettings() {
  const { preferences, updatePreferences, showToast, pushNotifications } = useAppContext()
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const refresh = () => setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [pushNotifications.enabled])
  const enabled = preferences.desktopNotifications && permission === 'granted'
  const toggle = async () => {
    if (enabled) { updatePreferences({ desktopNotifications: false }); return }
    if (typeof Notification === 'undefined') { showToast('当前浏览器不支持系统通知', 'warning'); return }
    setBusy(true)
    try {
      const next = await Notification.requestPermission(); setPermission(next)
      if (next === 'granted') updatePreferences({ desktopNotifications: true })
      else showToast('请在浏览器或系统设置中允许 OrbitPane 发送通知', 'warning')
    } catch { showToast('通知权限设置失败，请重试', 'error') }
    finally { setBusy(false) }
  }
  return <>
    <SettingsGroup title="任务完成提醒">
      <SettingRow title="浏览器通知" description="应用保持打开、你正在其他标签页时，提醒你任务已完成。">
        <button type="button" className="settings-switch" role="switch" aria-label="浏览器任务通知" aria-checked={enabled} disabled={busy} onClick={() => void toggle()}><span /></button>
      </SettingRow>
      <SettingRow title="后台推送" description="关闭应用后也接收任务结果。每台设备需要单独开启。"><PushNotificationButton /></SettingRow>
    </SettingsGroup>
    <p className="settings-footnote">手机后台推送需要已安装的应用和系统通知权限。iPhone / iPad 请从主屏幕打开 OrbitPane 后开启。</p>
  </>
}

function DataSettings() {
  const { conversations, updateConversation, deleteConversation, showToast } = useAppContext()
  const [busyId, setBusyId] = useState<number | null>(null)
  const archived = conversations.filter(conversation => conversation.is_archived)
  return <>
    <SettingsGroup title="已归档项目">
      {archived.length === 0 ? <div className="settings-empty"><Archive size={24} /><strong>暂无已归档项目</strong><p>在项目菜单中归档后，可以在这里恢复或删除。</p></div>
        : archived.map(conversation => <div key={conversation.id} className="settings-archive-row"><Folder size={17} /><div><strong>{conversation.name}</strong><span title={conversation.path}>{conversation.path}</span></div>
          <button className="settings-button" type="button" disabled={busyId === conversation.id} onClick={async () => {
            setBusyId(conversation.id)
            try { const updated = await updateConversation(conversation.id, { is_archived: false }); if (updated) showToast('项目已恢复') }
            finally { setBusyId(null) }
          }}>恢复</button>
          <button type="button" className="icon-btn destructive" aria-label={`删除已归档项目 ${conversation.name}`} onClick={event => deleteConversation(event, conversation.id)}><Trash2 size={15} /></button>
        </div>)}
    </SettingsGroup>
    <SettingsGroup title="对话与分享">
      <SettingRow title="导出、分享和清空对话" description="打开项目后，在对话右上角的「会话操作」菜单中管理。"><Info size={17} /></SettingRow>
      <SettingRow title="项目记录" description="归档会保留对话；删除项目会一并删除对话记录与分享链接。"><span className="settings-status">{conversations.length} 个项目</span></SettingRow>
    </SettingsGroup>
  </>
}

function SecuritySettings() {
  const { showToast } = useAppContext()
  const [binding, setBinding] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  return <>
    <SettingsGroup title="登录方式">
      <SettingRow title="通行密钥" description="使用设备上的指纹、面容或屏幕锁登录。">
        <button type="button" className="settings-button" disabled={binding || !supportsPasskeys()} onClick={async () => {
          setBinding(true)
          try { await registerPasskey(); showToast('通行密钥已绑定，下次可直接使用它登录') }
          catch (error) { showToast(passkeyError(error), 'error') }
          finally { setBinding(false) }
        }}><Fingerprint size={15} />{binding ? '正在绑定…' : '绑定通行密钥'}</button>
      </SettingRow>
      {!supportsPasskeys() && <p className="settings-inline-note">当前浏览器不支持通行密钥，请使用支持的浏览器和 HTTPS 连接。</p>}
    </SettingsGroup>
    <SettingsGroup title="当前登录">
      <SettingRow title="退出登录" description="退出这台设备上的登录，并关闭此设备的后台推送。">
        <button type="button" className="settings-button danger" disabled={signingOut} onClick={async () => {
          setSigningOut(true)
          try { await disablePush(); await apiFetch('/api/logout', { method: 'POST' }); window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)) }
          catch { showToast('退出失败，请稍后重试。', 'error'); setSigningOut(false) }
        }}><LogOut size={15} />{signingOut ? '正在退出…' : '退出登录'}</button>
      </SettingRow>
    </SettingsGroup>
  </>
}

function AboutSettings() {
  const { showToast } = useAppContext()
  const { isChecking, checkForUpdate } = useUpdateCheck(showToast)
  const [prompt, setPrompt] = useState(getPwaInstallPrompt)
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  const [installing, setInstalling] = useState(false)
  useEffect(() => {
    const unsubscribe = subscribeToPwaInstallPrompt(setPrompt)
    const onInstalled = () => setInstalled(true)
    window.addEventListener('appinstalled', onInstalled)
    return () => { unsubscribe(); window.removeEventListener('appinstalled', onInstalled) }
  }, [])
  return <>
    <div className="settings-about-brand"><LogoIcon size={44} /><div><strong>OrbitPane</strong><p>你的 AI 项目工作台</p></div></div>
    <SettingsGroup title="应用">
      <SettingRow title="应用更新" description="检查并获取最新版本。"><button type="button" className="settings-button" disabled={isChecking} onClick={() => void checkForUpdate()}><RefreshCw size={15} className={isChecking ? 'animate-spin' : ''} />{isChecking ? '正在检查…' : '检查更新'}</button></SettingRow>
      <SettingRow title="安装到设备" description="从桌面或主屏幕打开，使用独立应用窗口。">
        {installed ? <span className="settings-status available"><Check size={15} />已安装</span> : prompt ? <button type="button" className="settings-button" disabled={installing} onClick={async () => {
          setInstalling(true)
          try { await prompt.prompt(); await prompt.userChoice; clearPwaInstallPrompt() }
          catch { showToast('请通过浏览器菜单安装应用', 'info') }
          finally { setInstalling(false) }
        }}><Smartphone size={15} />{installing ? '正在安装…' : '安装应用'}</button> : <span className="settings-status">使用浏览器菜单安装</span>}
      </SettingRow>
      {!installed && !prompt && <p className="settings-inline-note">iPhone / iPad：Safari → 分享 → 添加到主屏幕。其他设备：浏览器菜单 → 安装应用 / 添加到主屏幕。</p>}
    </SettingsGroup>
  </>
}

function ProjectSettings() {
  const { settingsProjectId, activeConv, conversations, updateConversation, requestConfirm, showToast } = useAppContext()
  const conversation = settingsProjectId ? conversations.find(item => item.id === settingsProjectId) : activeConv
  const [name, setName] = useState(conversation?.name || '')
  const [busy, setBusy] = useState(false)
  const [tasksLoading, setTasksLoading] = useState(true)
  const [hasActiveTasks, setHasActiveTasks] = useState(true)
  const [tasksError, setTasksError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const conversationId = conversation?.id
  useEffect(() => { setName(conversation?.name || '') }, [conversation?.name])
  useEffect(() => {
    if (!conversationId) return
    const controller = new AbortController()
    setTasksLoading(true); setTasksError(false)
    apiFetch<{ items: TaskRecord[] }>(`/api/conversations/${conversationId}/tasks`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setHasActiveTasks(data.items.some(task => isTaskActive(task.status))) })
      .catch(() => { if (!controller.signal.aborted) { setHasActiveTasks(true); setTasksError(true) } })
      .finally(() => { if (!controller.signal.aborted) setTasksLoading(false) })
    return () => controller.abort()
  }, [conversationId, attempt])
  if (!conversation) return <div className="settings-empty"><Folder size={24} /><strong>未选择项目</strong><p>从项目列表或会话菜单打开项目设置。</p></div>
  const setPermission = async (mode: 'workspace' | 'unrestricted') => {
    if (conversation.permission_mode === mode) return
    setBusy(true)
    try {
      const updated = await updateConversation(conversation.id, { permission_mode: mode })
      if (updated) showToast(mode === 'workspace' ? '已启用受限工作区' : '已启用完全访问', mode === 'workspace' ? 'success' : 'warning')
    } finally { setBusy(false) }
  }
  return <>
    <div className="settings-scope-note"><Folder size={15} />这些设置仅影响「{conversation.name}」。</div>
    <SettingsGroup title="项目信息">
      <SettingRow title="项目名称"><form className="settings-name-form" onSubmit={async event => {
        event.preventDefault(); setBusy(true)
        try { const updated = await updateConversation(conversation.id, { name: name.trim() }); if (updated) showToast('项目名称已更新') }
        finally { setBusy(false) }
      }}><Input className="settings-input" aria-label="项目名称" value={name} onChange={event => setName(event.target.value)} /><button type="submit" className="settings-button" disabled={busy || !name.trim() || name.trim() === conversation.name}>保存</button></form></SettingRow>
      <SettingRow title="项目目录"><span className="settings-path" title={conversation.path}>{conversation.path}</span></SettingRow>
      <SettingRow title="当前模型" description="在消息输入框旁切换，修改将从下一次回复开始生效。"><span className="settings-status">{conversation.preferred_model ? formatModelName(conversation.preferred_model) : 'Agent 默认模型'}</span></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="文件系统权限">
      <div className="settings-permission-grid" role="radiogroup" aria-label="当前项目文件系统权限">
        <button type="button" role="radio" aria-checked={conversation.permission_mode === 'workspace'} disabled={busy || tasksLoading || hasActiveTasks} className={conversation.permission_mode === 'workspace' ? 'selected' : ''} onClick={() => void setPermission('workspace')}><ShieldCheck size={22} /><strong>受限工作区</strong><span>Agent 只能在项目目录内读写。</span></button>
        <button type="button" role="radio" aria-checked={conversation.permission_mode === 'unrestricted'} disabled={busy || tasksLoading || hasActiveTasks} className={`danger ${conversation.permission_mode === 'unrestricted' ? 'selected' : ''}`} onClick={() => {
          if (conversation.permission_mode === 'unrestricted') return
          requestConfirm({ id: `unrestricted-${conversation.id}`, title: '开启完全访问', description: `「${conversation.name}」的 Agent 将跳过审批与沙箱，可以修改运行账户能访问的任何文件。确定开启吗？`, confirmText: '开启完全访问', variant: 'destructive', onConfirm: () => { void setPermission('unrestricted') } })
        }}><ShieldAlert size={22} /><strong>完全访问</strong><span>跳过审批与沙箱，可访问运行账户允许的所有路径。</span></button>
      </div>
      {tasksLoading ? <p className="settings-inline-note">正在确认任务状态…</p> : tasksError ? <div className="settings-inline-note" role="status">无法确认任务状态，暂时不能修改权限。<button type="button" onClick={() => setAttempt(previous => previous + 1)}>重试</button></div>
        : hasActiveTasks && <div className="settings-inline-note">任务运行或排队时不能修改权限。<button type="button" onClick={() => setAttempt(previous => previous + 1)}>刷新状态</button></div>}
    </SettingsGroup>
    <SettingsGroup title="项目整理">
      <SettingRow title="星标置顶" description="在项目列表中优先显示。"><button type="button" className="settings-switch" role="switch" aria-label="项目星标置顶" aria-checked={conversation.is_pinned} onClick={() => void updateConversation(conversation.id, { is_pinned: !conversation.is_pinned })}><span /></button></SettingRow>
      <SettingRow title="归档项目" description="从左栏收起项目，对话记录仍然保留。"><button type="button" className="settings-button" onClick={() => void updateConversation(conversation.id, { is_archived: !conversation.is_archived })}><Archive size={15} />{conversation.is_archived ? '恢复项目' : '归档项目'}</button></SettingRow>
    </SettingsGroup>
  </>
}

export function SettingsPage() {
  const { settingsSection, settingsProjectId, activeConv, conversations, openSettings, closeSettings } = useAppContext()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pageRef = useFocusTrap<HTMLDivElement>(true, { initialFocus: () => headingRef.current })
  useEscapeLayer(true, closeSettings)
  const project = settingsProjectId ? conversations.find(item => item.id === settingsProjectId) : activeConv
  const section = SECTIONS.find(item => item.id === settingsSection)
  useEffect(() => { contentRef.current?.scrollTo(0, 0) }, [settingsSection])
  return <div ref={pageRef} className="settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <aside className="settings-navigation">
      <button type="button" className="settings-back" onClick={closeSettings}><ArrowLeft size={17} />返回工作台</button>
      <div className="settings-nav-heading"><Settings size={20} /><strong>设置</strong></div>
      <nav aria-label="设置分类">
        {SECTIONS.map(({ id, label, Icon }) => <button key={id} type="button" aria-current={settingsSection === id ? 'page' : undefined} className={settingsSection === id ? 'active' : ''} onClick={() => openSettings(id, settingsProjectId ?? undefined)}><Icon size={17} /><span>{label}</span></button>)}
        {(project || settingsSection === 'project') && <button type="button" className={`settings-project-nav ${settingsSection === 'project' ? 'active' : ''}`} aria-current={settingsSection === 'project' ? 'page' : undefined} onClick={() => openSettings('project', project?.id)}><Folder size={17} /><span>项目设置</span></button>}
      </nav>
      <span className="settings-nav-footer"><LogoIcon size={17} />OrbitPane</span>
    </aside>
    <div className="settings-content" ref={contentRef}><div className="settings-content-inner">
      <header className="settings-content-header"><span className="settings-breadcrumb">设置 <ChevronRight size={12} />{section?.label || '项目设置'}</span><h1 ref={headingRef} tabIndex={-1} id="settings-title">{section?.label || '项目设置'}</h1><p>{section?.description || '管理这个项目的名称、权限与归档状态。'}</p></header>
      {settingsSection === 'plugins' && <PluginsSettings />}{settingsSection === 'general' && <GeneralSettings />}{settingsSection === 'ai' && <AiSettings />}
      {settingsSection === 'notifications' && <NotificationSettings />}{settingsSection === 'data' && <DataSettings />}
      {settingsSection === 'security' && <SecuritySettings />}{settingsSection === 'about' && <AboutSettings />}
      {settingsSection === 'project' && <ProjectSettings key={project?.id} />}
    </div></div>
  </div>
}
