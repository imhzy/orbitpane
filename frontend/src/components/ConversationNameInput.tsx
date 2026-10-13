import { useAppContext } from '../contexts/AppContext'
import { useEscapeLayer } from '../hooks/useEscapeLayer'

/** Only the surface that opened the editor mounts this input. */
export function ConversationNameInput({ conversationId }: { conversationId: number }) {
  const { editingConvName, setEditingConvName, setEditingConvId, saveConvName } = useAppContext()
  useEscapeLayer(true, () => setEditingConvId(null))
  return <input
    type="text"
    className="cw-input conv-title-input"
    aria-label="项目名称"
    maxLength={120}
    value={editingConvName}
    autoFocus
    onFocus={event => event.currentTarget.select()}
    onClick={event => event.stopPropagation()}
    onChange={event => setEditingConvName(event.target.value)}
    onKeyDown={event => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        saveConvName(conversationId, event.currentTarget.value)
      }
    }}
    onBlur={event => saveConvName(conversationId, event.currentTarget.value)}
  />
}
