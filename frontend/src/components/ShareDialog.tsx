import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Copy, Eye, Link2, Loader2, Share2, ShieldAlert, Trash2, X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeLayer } from '../hooks/useEscapeLayer'
import { ApiError, apiFetch, describeApiError } from '../lib/api'
import { absoluteShareUrl } from '../lib/share'
import { haptic } from '../lib/nativeFeedback'
import { useAppContext } from '../contexts/AppContext'
import type { ShareLink, ShareLinkCreated } from '../lib/types'
import './ShareDialog.css'

interface ShareDialogProps {
  isOpen: boolean
  onClose: () => void
}

const EXPIRY_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: '长期有效', days: null },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
]

function formatDate(value?: string | null): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleDateString([], { year: 'numeric', month: 'numeric', day: 'numeric' })
}

/**
 * Publishes a read-only snapshot of the open project and manages its links.
 *
 * Two properties drive the whole design. A link is a *copy* taken at this
 * moment, so the dialog never promises a live view; and the token is returned
 * exactly once, so the freshly created URL stays on screen until the dialog is
 * dismissed and older links can only be listed or revoked, never re-read.
 */
export function ShareDialog({ isOpen, onClose }: ShareDialogProps) {
  const { activeConv, showToast, requestConfirm } = useAppContext()
  const [links, setLinks] = useState<ShareLink[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [includeThoughts, setIncludeThoughts] = useState(false)
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null)
  const [isCopied, setIsCopied] = useState(false)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const conversationId = activeConv?.id ?? null

  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
    initialFocus: () => closeRef.current,
  })
  useEscapeLayer(isOpen, onClose)

  useEffect(() => {
    if (!isOpen || conversationId === null) return
    let cancelled = false
    setIsLoading(true)
    setCreatedUrl(null)
    setIsCopied(false)
    apiFetch<{ items: ShareLink[] }>(`/api/conversations/${conversationId}/shares`)
      .then(response => {
        if (!cancelled) setLinks(response.items ?? [])
      })
      .catch(error => {
        if (!cancelled) showToast(describeApiError(error, '无法加载分享链接'), 'error')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, conversationId, showToast])

  const createLink = useCallback(async () => {
    if (conversationId === null || isCreating) return
    setIsCreating(true)
    try {
      const created = await apiFetch<ShareLinkCreated>(
        `/api/conversations/${conversationId}/shares`,
        {
          method: 'POST',
          body: JSON.stringify({
            include_thoughts: includeThoughts,
            expires_in_days: expiresInDays,
          }),
        },
      )
      const url = absoluteShareUrl(created.url_path)
      setCreatedUrl(url)
      setLinks(current => [created, ...current])
      // Best effort: a clipboard that refuses still leaves the URL on screen.
      void navigator.clipboard?.writeText(url).then(
        () => {
          setIsCopied(true)
          showToast('分享链接已生成并复制')
          window.setTimeout(() => setIsCopied(false), 2000)
        },
        () => showToast('分享链接已生成'),
      )
      haptic('success')
    } catch (error) {
      // The only failure with an action attached to it: the cap exists so the
      // list of live links stays something a person can actually review.
      showToast(
        error instanceof ApiError && error.status === 409
          ? '分享链接数量已达上限，请先撤销一个再生成'
          : describeApiError(error, '创建分享链接失败'),
        'error',
      )
    } finally {
      setIsCreating(false)
    }
  }, [conversationId, expiresInDays, includeThoughts, isCreating, showToast])

  const revokeLink = useCallback(
    (link: ShareLink) => {
      if (conversationId === null) return
      requestConfirm({
        id: `revoke-share-${link.id}`,
        title: '撤销这个分享链接？',
        description: '链接会立刻失效，已经打开过页面的人也无法再次访问。这一步无法撤销。',
        confirmText: '撤销链接',
        variant: 'destructive',
        onConfirm: () => {
          void apiFetch(`/api/conversations/${conversationId}/shares/${link.id}`, {
            method: 'DELETE',
          })
            .then(() => {
              setLinks(current => current.filter(item => item.id !== link.id))
              showToast('分享链接已撤销')
            })
            .catch(error => showToast(describeApiError(error, '撤销失败'), 'error'))
        },
      })
    },
    [conversationId, requestConfirm, showToast],
  )

  const copyCreatedUrl = useCallback(() => {
    if (!createdUrl) return
    void navigator.clipboard
      ?.writeText(createdUrl)
      .then(() => {
        setIsCopied(true)
        showToast('已复制到剪贴板')
        window.setTimeout(() => setIsCopied(false), 2000)
      })
      .catch(() => showToast('复制失败，请手动选择链接', 'error'))
  }, [createdUrl, showToast])

  const shareCreatedUrl = useCallback(() => {
    if (!createdUrl || !navigator.share) return
    void navigator
      .share({ title: activeConv?.name ?? 'OrbitPane 对话', url: createdUrl })
      .catch(() => undefined)
  }, [activeConv?.name, createdUrl])

  /* Portalled to the body because the trigger lives in `.chat-header`, which
     has both a `z-index` and a `backdrop-filter` — so it is a stacking context
     *and* the containing block for fixed descendants. A modal rendered inside
     it would be clipped to a 60px strip and painted under the drawer. */
  return createPortal(
    <AnimatePresence>
      {isOpen && activeConv && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="share-overlay"
          onClick={onClose}
        >
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="share-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-dialog-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="share-sheet-handle" aria-hidden="true" />
            <div className="share-card-head">
              <div>
                <h3 id="share-dialog-title">分享这个对话</h3>
                <p className="share-card-subtitle">
                  生成一个只读链接，对方无需登录即可查看
                  <strong>此刻</strong>
                  的对话快照，之后的新消息不会出现在里面。
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                className="icon-btn"
                onClick={onClose}
                aria-label="关闭分享面板"
              >
                <X size={16} />
              </button>
            </div>

            {createdUrl && (
              <div className="share-result">
                <label className="share-result-label" htmlFor="share-created-url">
                  <Link2 size={13} />
                  分享链接
                </label>
                <div className="share-result-row">
                  <input
                    id="share-created-url"
                    className="cw-input share-url-input"
                    value={createdUrl}
                    readOnly
                    onFocus={event => event.currentTarget.select()}
                  />
                  <button type="button" className="share-copy-btn" onClick={copyCreatedUrl}>
                    {isCopied ? <Check size={14} /> : <Copy size={14} />}
                    {isCopied ? '已复制' : '复制'}
                  </button>
                  {typeof navigator !== 'undefined' && !!navigator.share && (
                    <button
                      type="button"
                      className="share-copy-btn"
                      onClick={shareCreatedUrl}
                      aria-label="调用系统分享"
                    >
                      <Share2 size={14} />
                    </button>
                  )}
                </div>
                {/* Said once, at the moment it becomes true. */}
                <p className="share-result-note">
                  链接现在就是有效的。任何拿到它的人都能查看，请确认这段对话里没有密钥、凭据或私密信息。
                </p>
              </div>
            )}

            <div className="share-options">
              <label className="share-option-row">
                <input
                  type="checkbox"
                  checked={includeThoughts}
                  onChange={event => setIncludeThoughts(event.target.checked)}
                />
                <span>
                  <strong>包含 Agent 执行过程</strong>
                  <small>思考、命令与工具输出会一并公开，其中常含文件路径与终端内容。</small>
                </span>
              </label>

              <div className="share-option-row share-expiry-row">
                <span>
                  <strong>有效期</strong>
                  <small>到期后链接失效，快照也会从服务器删除。</small>
                </span>
                <div className="share-expiry-choices" role="group" aria-label="链接有效期">
                  {EXPIRY_CHOICES.map(choice => (
                    <button
                      key={choice.label}
                      type="button"
                      className={expiresInDays === choice.days ? 'active' : ''}
                      aria-pressed={expiresInDays === choice.days}
                      onClick={() => setExpiresInDays(choice.days)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              type="button"
              className="share-create-btn"
              disabled={isCreating}
              onClick={() => void createLink()}
            >
              {isCreating ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
              {isCreating ? '正在生成…' : createdUrl ? '再生成一个链接' : '生成分享链接'}
            </button>

            <div className="share-links">
              <div className="share-links-title">
                已生成的链接
                {links.length > 0 && <span>{links.length}</span>}
              </div>
              {isLoading ? (
                <p className="share-links-empty">正在加载…</p>
              ) : links.length === 0 ? (
                <p className="share-links-empty">这个项目还没有对外分享过。</p>
              ) : (
                <ul>
                  {links.map(link => (
                    <li key={link.id}>
                      <div className="share-link-facts">
                        <strong>{formatDate(link.created_at)} 的快照</strong>
                        <span>
                          {link.message_count} 条消息
                          {link.include_thoughts ? ' · 含执行过程' : ''}
                          {link.expires_at ? ` · ${formatDate(link.expires_at)} 到期` : ''}
                        </span>
                      </div>
                      <span className="share-link-views" title="被打开的次数">
                        <Eye size={12} />
                        {link.view_count}
                      </span>
                      <button
                        type="button"
                        className="share-revoke-btn"
                        onClick={() => revokeLink(link)}
                        aria-label="撤销这个分享链接"
                        title="撤销"
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="share-privacy-note">
              <ShieldAlert size={13} />
              分享出去的内容不含工作区路径，但仍是完整的对话正文。清空对话或删除项目会一并撤销它的所有链接。
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
