import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { useAppContext } from '../contexts/AppContext'
import { Input, Select } from './FormControls'

type Property = { title?: string; description?: string; type?: string; default?: string | number | boolean; enum?: string[]; minimum?: number; maximum?: number; maxLength?: number }
type Plugin = { id: string; plugin_id: string; name: string; description: string; enabled: boolean; config: Record<string, string | number | boolean>; configured_secrets: string[]; secret_fields: string[]; schema: { properties: Record<string, Property>; required?: string[] } }

function PluginForm({ plugin, onDelete, onSave }: { plugin: Plugin; onDelete: () => void; onSave: (updated: Plugin) => void }) {
  const { requestConfirm } = useAppContext()
  const [name, setName] = useState(plugin.name)
  const [enabled, setEnabled] = useState(plugin.enabled)
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => ({ ...Object.fromEntries(Object.entries(plugin.schema.properties).filter(([, p]) => p.default !== undefined).map(([k, p]) => [k, p.default!])), ...plugin.config }))
  const [secrets, setSecrets] = useState(plugin.configured_secrets)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('')
    const config = { ...values }
    for (const key of plugin.secret_fields) if (config[key] === '' || config[key] === undefined) delete config[key]
    try {
      const data = await apiFetch<{ items: Plugin[] }>(`/api/plugins/${plugin.id}`, { method: 'PUT', body: JSON.stringify({ name, enabled, config }) })
      const updated = data.items.find(item => item.id === plugin.id)!
      onSave(updated)
      setName(updated.name)
      setSecrets(updated.configured_secrets)
      setValues(previous => { const next = { ...previous }; for (const key of plugin.secret_fields) delete next[key]; return next })
      setError(false); setMessage(enabled ? '已保存并全局启用。已开启此插件的项目可在下次任务调用。' : '已保存并关闭，后续调用将被拒绝。')
    } catch (reason) { setError(true); setMessage(reason instanceof Error ? reason.message : '保存失败，请重试') }
    finally { setBusy(false) }
  }
  return <form onSubmit={event => void save(event)} className="project-plugin-form">
    <div className="settings-row"><div className="settings-row-copy"><h3>{plugin.name}</h3><p>{plugin.description}</p></div><button type="button" className="settings-switch" role="switch" aria-label={`启用${plugin.name}`} aria-checked={enabled} disabled={busy} onClick={() => { setEnabled(!enabled); setMessage('') }}><span /></button></div>
    <fieldset disabled={busy} className="project-plugin-fields">
      <div className="settings-row"><label htmlFor={`plugin-${plugin.id}-name`}>插件名称</label><Input id={`plugin-${plugin.id}-name`} value={name} required maxLength={100} onChange={event => setName(event.target.value)} /></div>
      {Object.entries(plugin.schema.properties).map(([key, field]) => {
        const secret = plugin.secret_fields.includes(key)
        const id = `plugin-${plugin.id}-${key}`
        return <div className="settings-row" key={key}><div className="settings-row-copy"><label htmlFor={id}>{field.title || key}</label>{field.description && <p>{field.description}</p>}</div><div className="settings-row-control">
          {field.enum ? <Select id={id} aria-label={field.title || key} value={String(values[key] ?? '')} options={field.enum.map(value => ({ value, label: value.toUpperCase() }))} onChange={value => setValues({ ...values, [key]: value })} />
            : field.type === 'boolean' ? <input id={id} type="checkbox" checked={Boolean(values[key])} onChange={event => setValues({ ...values, [key]: event.target.checked })} />
              : <Input id={id} className="settings-input" type={secret ? 'password' : field.type === 'integer' ? 'number' : 'text'} autoComplete={secret ? 'new-password' : 'off'} value={String(values[key] ?? '')} min={field.minimum} max={field.maximum} maxLength={field.maxLength} required={enabled && plugin.schema.required?.includes(key) && !(secret && secrets.includes(key))} placeholder={secret && secrets.includes(key) ? '已配置，留空保持不变' : undefined} onChange={event => setValues({ ...values, [key]: field.type === 'integer' && event.target.value !== '' ? Number(event.target.value) : event.target.value })} />}
        </div></div>
      })}
    </fieldset>
    <div className="project-plugin-actions"><button className="settings-button" type="submit" disabled={busy}>{busy ? '保存中…' : '保存插件设置'}</button><button type="button" className="settings-button danger" disabled={busy} onClick={() => requestConfirm({ id: `delete-plugin-${plugin.id}`, title: '删除全局插件', description: `删除「${name}」的配置，并从所有项目移除。`, confirmText: '删除', variant: 'destructive', onConfirm: () => {
      setBusy(true)
      void apiFetch(`/api/plugins/${plugin.id}`, { method: 'DELETE' }).then(onDelete).catch(reason => { setError(true); setMessage(reason instanceof Error ? reason.message : '删除失败') }).finally(() => setBusy(false))
    } })}>删除插件</button>{message && <p role={error ? 'alert' : 'status'}>{message}</p>}</div>
  </form>
}

export function PluginsSettings() {
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  const [definitions, setDefinitions] = useState<{ id: string; name: string }[]>([])
  const [kind, setKind] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    apiFetch<{ items: Plugin[]; definitions: { id: string; name: string }[] }>('/api/plugins', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setPlugins(data.items); setDefinitions(data.definitions); setKind(previous => previous || data.definitions[0]?.id || ''); setError('') } })
      .catch(() => { if (!controller.signal.aborted) setError('插件加载失败，请重试') })
    return () => controller.abort()
  }, [attempt])
  return <>
    <p className="settings-footnote">在这里统一管理插件配置，可添加多个插件，也可为同一种插件配置多个账号。保存并全局启用后，在项目设置中选择允许调用的插件。</p>
    <section className="settings-group"><h2>添加插件</h2><form className="settings-group-body" onSubmit={event => {
      event.preventDefault(); setBusy(true); setError('')
      void apiFetch<{ items: Plugin[] }>('/api/plugins', { method: 'POST', body: JSON.stringify({ plugin_id: kind, name: name.trim() }) })
        .then(data => { setPlugins(data.items); setName('') }).catch(reason => setError(reason instanceof Error ? reason.message : '添加失败')).finally(() => setBusy(false))
    }}><div className="settings-row"><label htmlFor="plugin-kind">插件类型</label><Select id="plugin-kind" aria-label="插件类型" value={kind} onChange={setKind} options={definitions.map(item => ({ value: item.id, label: item.name }))} disabled={busy} /></div>
      <div className="settings-row"><label htmlFor="new-plugin-name">名称</label><Input id="new-plugin-name" placeholder="例如：工作邮箱" value={name} maxLength={100} required onChange={event => setName(event.target.value)} disabled={busy} /></div>
      <div className="project-plugin-actions"><button type="submit" className="settings-button" disabled={busy || !kind || !name.trim()}>{busy ? '添加中…' : '添加插件'}</button></div>
    </form></section>
    {error && <div role="alert" className="settings-inline-note">{error}<button type="button" onClick={() => setAttempt(attempt + 1)}>重试加载</button></div>}
    {plugins === null ? <p className="settings-footnote">正在加载插件…</p> : plugins.length === 0 ? <div className="settings-empty"><strong>尚未添加插件</strong><p>选择插件类型并填写名称，添加后配置账号和密钥；全局启用后，所有项目的新任务均可调用。</p></div> : plugins.map(plugin => <section key={plugin.id} className="settings-group"><h2>{plugin.name}</h2><div className="settings-group-body"><PluginForm plugin={plugin} onSave={updated => setPlugins(previous => previous?.map(item => item.id === updated.id ? updated : item) ?? [])} onDelete={() => setPlugins(previous => previous?.filter(item => item.id !== plugin.id) ?? [])} /></div></section>)}
  </>
}
