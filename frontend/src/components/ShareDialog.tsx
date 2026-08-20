import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Copy, Eye, KeyRound, Link2, Loader2, Share2, ShieldAlert, Trash2, X } from 'lucide-react'
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
 * A link is a *copy* taken at the moment it is made, so the dialog never
 * promises a live view. Every link the project still has is listed with its
 * full address: the backend keeps each token sealed and unseals it for this
 * list, so a link created last week can be copied again rather than only
 * revoked. A link from before that was kept — or one sealed with a signing
 * secret that has since been rotated — is listed without an address.
 */
export function ShareDialog({ isOpen, onClose }: ShareDialogProps) {
  const { activeConv, showToast, requestConfirm } = useAppContext()
  const [links, setLinks] = useState<ShareLink[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  /** The link made in this sitting: highlighted, scrolled to, and warned about. */
  const [freshId, setFreshId] = useState<number | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [includeThoughts, setIncludeThoughts] = useState(false)
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const freshRef = useRef<HTMLLIElement | null>(null)
  const copiedTimer = useRef<number | null>(null)
  const conversationId = activeConv?.id ?? null
  const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share

  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
    initialFocus: () => closeRef.current,
  })
  useEscapeLayer(isOpen, onClose)

  const markCopied = useCallback((id: number) => {
    setCopiedId(id)
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopiedId(null), 2000)
  }, [])

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
  }, [])

  useEffect(() => {
    if (!isOpen || conversationId === null) return
    let cancelled = false
    setIsLoading(true)
    setFreshId(null)
    setCopiedId(null)
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

  // The new link lands in the list below the button that made it, which on a
  // phone sheet is usually just off screen.
  useEffect(() => {
    if (freshId === null) return
    freshRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [freshId])

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
      setLinks(current => [created, ...current])
      setFreshId(created.id)
      // Best effort: a clipboard that refuses still leaves the URL on screen.
      void navigator.clipboard?.writeText(absoluteShareUrl(created.url_path)).then(
        () => {
          markCopied(created.id)
          showToast('分享链接已生成并复制')
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
  }, [conversationId, expiresInDays, includeThoughts, isCreating, markCopied, showToast])

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
              setFreshId(current => (current === link.id ? null : current))
              showToast('分享链接已撤销')
            })
            .catch(error => showToast(describeApiError(error, '撤销失败'), 'error'))
        },
      })
    },
    [conversationId, requestConfirm, showToast],
  )

  const copyLink = useCallback(
    (link: ShareLink) => {
      if (!link.url_path) return
      void navigator.clipboard
        ?.writeText(absoluteShareUrl(link.url_path))
        .then(() => {
          markCopied(link.id)
          showToast('已复制到剪贴板')
        })
        .catch(() => showToast('复制失败，请手动选择链接', 'error'))
    },
    [markCopied, showToast],
  )

  const shareLink = useCallback(
    (link: ShareLink) => {
      if (!link.url_path || !navigator.share) return
      void navigator
        .share({
          title: activeConv?.name ?? 'OrbitPane 对话',
          url: absoluteShareUrl(link.url_path),
        })
        .catch(() => undefined)
    },
    [activeConv?.name],
  )

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
              {isCreating ? '正在生成…' : freshId !== null ? '再生成一个链接' : '生成分享链接'}
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
                  {links.map(link => {
                    const isFresh = link.id === freshId
                    const url = link.url_path ? absoluteShareUrl(link.url_path) : null
                    return (
                      <li
                        key={link.id}
                        ref={isFresh ? freshRef : undefined}
                        className={isFresh ? 'is-fresh' : undefined}
                      >
                        <div className="share-link-head">
                          <div className="share-link-facts">
                            <strong>
                              {formatDate(link.created_at)} 的快照
                              {isFresh && <em>刚刚生成</em>}
                            </strong>
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
                        </div>

                        {url ? (
                          <div className="share-link-url-row">
                            <input
                              className="cw-input share-url-input"
                              value={url}
                              readOnly
                              aria-label="分享链接地址"
                              onFocus={event => event.currentTarget.select()}
                            />
                            <button
                              type="button"
                              className="share-copy-btn"
                              onClick={() => copyLink(link)}
                            >
                              {copiedId === link.id ? <Check size={14} /> : <Copy size={14} />}
                              {copiedId === link.id ? '已复制' : '复制'}
                            </button>
                            {canNativeShare && (
                              <button
                                type="button"
                                className="share-copy-btn"
                                onClick={() => shareLink(link)}
                                aria-label="调用系统分享"
                              >
                                <Share2 size={14} />
                              </button>
                            )}
                          </div>
                        ) : (
                          <p className="share-link-unreadable">
                            <KeyRound size={13} />
                            服务器已无法还原这条链接的地址（生成于更早的版本，或签名密钥已更换）。它对拿到过链接的人依然有效，如果地址丢了，撤销后重新生成一个。
                          </p>
                        )}

                        {/* Said once, at the moment it becomes true. */}
                        {isFresh && (
                          <p className="share-link-note">
                            链接现在就是有效的。任何拿到它的人都能查看，请确认这段对话里没有密钥、凭据或私密信息。
                          </p>
                        )}
                      </li>
                    )
                  })}
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
