import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentProps, KeyboardEvent, ReactNode } from 'react'
import { Check, ChevronDown, Clock3, Minus, Plus } from 'lucide-react'
import { useFieldPopover } from '../hooks/useFieldPopover'
import './FormControls.css'

function classes(...values: Array<string | undefined | false>) {
  return values.filter(Boolean).join(' ')
}

export function Input({ className, inline, ...props }: ComponentProps<'input'> & { inline?: boolean }) {
  return <input {...props} className={classes('ui-input', inline && 'ui-input-inline', className)} />
}

export function Textarea({ className, inline, ...props }: ComponentProps<'textarea'> & { inline?: boolean }) {
  return <textarea {...props} className={classes('ui-textarea', inline && 'ui-input-inline', className)} />
}

export function Checkbox({ className, tone, ...props }: ComponentProps<'input'> & { tone?: 'danger' }) {
  return <input {...props} type="checkbox" className={classes('ui-checkbox', tone === 'danger' && 'ui-checkbox-danger', className)} />
}

export interface SelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  'aria-label': string
  'aria-describedby'?: string
  id?: string
  className?: string
  disabled?: boolean
  placeholder?: string
  icon?: ReactNode
  /** Editable comboboxes also accept values outside the suggestion list. */
  editable?: boolean
  required?: boolean
  maxLength?: number
}

export function Select({ value, onChange, options, id, className, disabled, placeholder = '请选择',
  icon, editable = false, required, maxLength, 'aria-label': label, 'aria-describedby': describedBy }: SelectProps) {
  const generatedId = useId()
  const controlId = id || generatedId
  const listId = `${controlId}-options`
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [filtering, setFiltering] = useState(false)
  const controlRef = useRef<HTMLInputElement | HTMLButtonElement>(null)
  const assignControl = (element: HTMLInputElement | HTMLButtonElement | null) => { controlRef.current = element }
  const typeahead = useRef({ text: '', time: 0 })
  const { anchorRef, popupRef, style } = useFieldPopover(open && !disabled, () => {
    setOpen(false)
    controlRef.current?.focus({ preventScroll: true })
  })
  const selected = options.find(option => option.value === value)
  const visibleOptions = editable && filtering
    ? options.filter(option => `${option.label} ${option.value}`.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
    : options
  const activeOption = visibleOptions[activeIndex]

  useEffect(() => {
    if (open && activeOption) {
      const option = document.getElementById(`${listId}-${activeIndex}`)
      const popup = popupRef.current
      if (option && popup) {
        const top = option.offsetTop
        if (top < popup.scrollTop) popup.scrollTop = top
        else if (top + option.offsetHeight > popup.scrollTop + popup.clientHeight) {
          popup.scrollTop = top + option.offsetHeight - popup.clientHeight
        }
      }
    }
  }, [open, activeIndex, activeOption, listId, popupRef])

  const show = (last = false) => {
    if (disabled) return
    setFiltering(false)
    const selectedIndex = options.findIndex(option => option.value === value && !option.disabled)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex
      : last ? options.findLastIndex(option => !option.disabled) : options.findIndex(option => !option.disabled))
    setOpen(true)
  }

  const choose = (option: SelectOption) => {
    if (option.disabled) return
    onChange(option.value)
    setOpen(false)
    controlRef.current?.focus({ preventScroll: true })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Tab') { setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { show(event.key === 'ArrowUp'); return }
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const start = activeIndex < 0 ? (direction > 0 ? -1 : 0) : activeIndex
      for (let step = 1; step <= visibleOptions.length; step++) {
        const index = (start + direction * step + visibleOptions.length) % visibleOptions.length
        if (!visibleOptions[index].disabled) { setActiveIndex(index); break }
      }
    } else if (open && (event.key === 'Home' || event.key === 'End') && !editable) {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? visibleOptions.findIndex(option => !option.disabled)
        : visibleOptions.findLastIndex(option => !option.disabled))
    } else if (event.key === 'Enter' || (!editable && event.key === ' ')) {
      if (editable && !open) return
      event.preventDefault()
      if (!open) show()
      else if (activeOption) choose(activeOption)
      else setOpen(false)
    } else if (!editable && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const now = Date.now()
      const query = (now - typeahead.current.time < 700 ? typeahead.current.text : '') + event.key.toLocaleLowerCase()
      typeahead.current = { text: query, time: now }
      const match = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(query))
      if (match >= 0) { setActiveIndex(match); setOpen(true) }
    }
  }

  const accessibility = {
    id: controlId, role: 'combobox', 'aria-label': label, 'aria-describedby': describedBy,
    'aria-expanded': open && !disabled, 'aria-controls': open && !disabled ? listId : undefined,
    'aria-haspopup': 'listbox' as const,
    'aria-activedescendant': open && activeOption ? `${listId}-${activeIndex}` : undefined,
    disabled, onKeyDown: handleKeyDown,
  }

  return <div ref={anchorRef} className={classes('ui-select', editable && 'ui-select-editable', className)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    {editable ? <div className="ui-select-editable-control">
      <Input {...accessibility} ref={assignControl} value={value} required={required} maxLength={maxLength}
        aria-autocomplete="list" autoComplete="off" spellCheck={false} placeholder={placeholder}
        onChange={event => {
          onChange(event.target.value)
          setFiltering(true)
          setActiveIndex(-1)
          setOpen(true)
        }} />
      <button type="button" className="ui-select-toggle" tabIndex={-1} disabled={disabled}
        aria-label={`${label}选项`} onPointerDown={event => event.preventDefault()}
        onClick={() => { controlRef.current?.focus(); if (open) setOpen(false); else show() }}>
        <ChevronDown size={15} className={open ? 'open' : ''} aria-hidden="true" />
      </button>
    </div> : <button {...accessibility} type="button" ref={assignControl} className="ui-select-trigger"
      onClick={() => { if (open) setOpen(false); else show() }}>
      {icon && <span className="ui-select-icon" aria-hidden="true">{icon}</span>}
      <span className={classes('ui-select-value', !selected && 'ui-select-placeholder')} title={selected?.label}>{selected?.label || placeholder}</span>
      <ChevronDown size={15} className={classes('ui-select-chevron', open && 'open')} aria-hidden="true" />
    </button>}
    {open && !disabled && <div ref={popupRef} popover="manual" style={style} className="ui-field-popover ui-select-menu"
      id={listId} role="listbox" aria-label={`${label}选项`} onPointerDown={event => event.preventDefault()}>
      {visibleOptions.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option"
        aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        className={classes('ui-select-option', option.value === value && 'selected', index === activeIndex && 'active')}
        onPointerMove={() => { if (!option.disabled) setActiveIndex(index) }} onClick={() => choose(option)}>
        <span className="ui-select-option-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
        {option.value === value && <Check size={15} aria-hidden="true" />}
      </div>)}
      {visibleOptions.length === 0 && <p className="ui-select-empty">{editable ? '可直接输入完整时区名称' : '暂无可用选项'}</p>}
    </div>}
  </div>
}

interface NumberInputProps extends Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'value'> {
  value: string
  onChange: (value: string) => void
}

export function NumberInput({ value, onChange, className, disabled, min, max, step = 1, ...props }: NumberInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const change = (direction: number) => {
    const input = inputRef.current
    if (!input) return
    if (direction > 0) input.stepUp(); else input.stepDown()
    onChange(input.value)
    input.focus({ preventScroll: true })
  }
  return <div className={classes('ui-number', className)}>
    <Input {...props} ref={inputRef} type="number" inputMode="numeric" value={value} min={min} max={max} step={step}
      disabled={disabled} onChange={event => onChange(event.target.value)} />
    <div className="ui-number-actions">
      <button type="button" aria-label={`减少${props['aria-label'] || '数值'}`} disabled={disabled || (value !== '' && min !== undefined && Number(value) <= Number(min))}
        onClick={() => change(-1)}><Minus size={13} aria-hidden="true" /></button>
      <button type="button" aria-label={`增加${props['aria-label'] || '数值'}`} disabled={disabled || (value !== '' && max !== undefined && Number(value) >= Number(max))}
        onClick={() => change(1)}><Plus size={13} aria-hidden="true" /></button>
    </div>
  </div>
}

const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour).padStart(2, '0'), label: String(hour).padStart(2, '0') }))
const MINUTES = Array.from({ length: 60 }, (_, minute) => ({ value: String(minute).padStart(2, '0'), label: String(minute).padStart(2, '0') }))

export function TimeInput({ value, onChange, className, disabled, ...props }: NumberInputProps) {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const close = () => { setOpen(false); inputRef.current?.focus({ preventScroll: true }) }
  const { anchorRef, popupRef, style } = useFieldPopover(open && !disabled, close)
  const label = props['aria-label'] || '时间'
  const hour = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value.slice(0, 2) : '09'
  const minute = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value.slice(3, 5) : '00'
  return <div ref={anchorRef} className={classes('ui-time', className)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <Input {...props} ref={inputRef} type="text" inputMode="numeric" value={value} disabled={disabled}
      pattern="([01][0-9]|2[0-3]):[0-5][0-9]" placeholder="HH:MM" maxLength={5} autoComplete="off"
      onChange={event => {
        const next = event.target.value
        // Phone number pads have no colon key. Accept 0930 as well as 09:30.
        onChange(/^\d{3,4}$/.test(next) ? `${next.slice(0, 2)}:${next.slice(2)}` : next)
      }}
      onBlur={event => {
        const next = event.target.value
        if (/^\d:[0-5]\d$/.test(next)) onChange(`0${next}`)
        props.onBlur?.(event)
      }} />
    <button type="button" className="ui-time-toggle" aria-label={`选择${label}`} aria-expanded={open && !disabled}
      aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(previous => !previous)}>
      <Clock3 size={16} aria-hidden="true" />
    </button>
    {open && !disabled && <div ref={popupRef} popover="manual" style={style} className="ui-field-popover ui-time-menu"
      role="dialog" aria-label={`选择${label}`}>
      <div className="ui-time-heading"><Clock3 size={15} aria-hidden="true" /><span>选择时间</span><small>24 小时制</small></div>
      <div className="ui-time-columns">
        <div><span className="ui-field-label">小时</span><Select aria-label={`${label}小时`} value={hour} options={HOURS} onChange={next => onChange(`${next}:${minute}`)} /></div>
        <span className="ui-time-separator" aria-hidden="true">:</span>
        <div><span className="ui-field-label">分钟</span><Select aria-label={`${label}分钟`} value={minute} options={MINUTES} onChange={next => onChange(`${hour}:${next}`)} /></div>
      </div>
      <button type="button" className="ui-btn primary ui-time-done" onClick={() => { onChange(`${hour}:${minute}`); close() }}>完成</button>
    </div>}
  </div>
}
