import { Cpu, MessageSquare } from 'lucide-react'
import type { ModelOption, Provider, ProviderBadge } from './types'
import { readJson, writeJson } from './storage'

const MODEL_LABEL_CACHE_KEY = 'orbitpane_model_labels_v1'

const TONE_CLASS: Record<string, string> = {
  gemini: 'badge-gemini',
  codex: 'badge-codex',
  default: 'badge-default',
}

/**
 * Labels accumulated from every `/api/models` response.
 *
 * Historical messages reference models whose provider may not be the one
 * currently loaded, so the label lookup cannot be scoped to the active list.
 * The cache is persisted so a reload still renders old turns with real names
 * rather than raw ids.
 */
const modelLabels = new Map<string, string>(
  Object.entries(readJson<Record<string, string>>(MODEL_LABEL_CACHE_KEY, {})),
)

export function rememberModelLabels(models: ModelOption[]): void {
  let changed = false
  for (const model of models) {
    if (!model?.id || modelLabels.get(model.id) === model.display_name) continue
    modelLabels.set(model.id, model.display_name)
    changed = true
  }
  if (changed) {
    writeJson(MODEL_LABEL_CACHE_KEY, Object.fromEntries(modelLabels))
  }
}

/**
 * Display label for a model id. Falls back to the raw id, which is honest —
 * the backend owns naming, so an unknown id means we genuinely have no label
 * rather than a client map that has fallen behind.
 */
export function formatModelName(modelId: string): string {
  if (!modelId) return ''
  return modelLabels.get(modelId) || modelId
}

/**
 * Whether naming the agent on every project row carries information.
 *
 * The catalog always lists every adapter the build knows about, including ones
 * the deployment has turned off, so its raw length is not the question. What
 * matters is whether two projects could actually be running on different
 * agents — until then the label reads identically on every row and is pure
 * chrome.
 */
export function hasProviderChoice(providers: Provider[] = []): boolean {
  return providers.filter(provider => provider.available).length > 1
}

/** Badge metadata driven by the provider catalog rather than id string-matching. */
export function getProviderBadge(
  providerId?: string,
  providers: Provider[] = [],
): ProviderBadge {
  const provider = providers.find(candidate => candidate.id === providerId)
  const tone = provider?.tone || 'default'
  return {
    text: provider?.name || providerId || '未知 Agent',
    type: tone,
    className: TONE_CLASS[tone] || TONE_CLASS.default,
    Icon: provider ? Cpu : MessageSquare,
  }
}
