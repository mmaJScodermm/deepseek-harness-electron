/**
 * Models settings section: the provider rows joined from the configurable
 * directory, settings namespaces, and credential states, with one editor
 * card at a time. Rows expose only confirmed API-key state through accessible
 * solid configured or missing dots. A whole-section provider without a
 * configured key renders as its open setup card instead of a row, but only in
 * the first-run posture — no provider on the page can serve requests yet — and
 * only until the user closes that card; the add flow is a card carrying the
 * dormant-provider select. Each card kind owns its own open state, so closing
 * one never discards a draft in another. Every mutation writes through the
 * wire, while a provider removal first requires confirmation; the page
 * re-renders from pushed invalidations or the post-apply reload.
 */

import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, ModelProviderGroup, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { deriveKeyRef, messageOf, protocolChoices, providerUsable } from './store.ts'
import type { ModelsSettingsState, ModelsSettingsStore, ProviderRow } from './store.ts'
import { ProviderEditor, type ProviderEditorProps } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<ModelsSettingsState>
  /** Wire faces the editor writes through. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type ModelsSectionProps = Partial<ModelsSectionInjected>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** Settings namespace owned by the optional Host image-analysis plugin. */
export const IMAGE_ANALYSIS_NAMESPACE = 'llm-image-analysis'

/** One image-capable route offered by the visual-model selector. */
export interface VisualModelOption {
  provider: string
  providerName: string
  model: string
  modelName: string
}

/** Select only exact catalog entries that explicitly advertise image input. */
export function visualModelOptions(groups: readonly ModelProviderGroup[]): VisualModelOption[] {
  return groups.flatMap(group => group.models.flatMap(model =>
    model.inputModalities?.includes('image') === true
      ? [{ provider: group.id, providerName: group.name, model: model.id, modelName: model.name }]
      : []))
}

/** Encode an exact route without imposing delimiter restrictions on provider or model ids. */
function visualRouteValue(route: { provider: string; model: string } | undefined): string {
  return route === undefined ? '' : JSON.stringify([route.provider, route.model])
}

/** Read a complete optional route from the redacted settings descriptor. */
function visualRouteOf(namespace: SettingsNamespaceView | undefined): { provider: string; model: string } | undefined {
  if (typeof namespace?.value !== 'object' || namespace.value === null) return undefined
  const value = namespace.value as { provider?: unknown; model?: unknown }
  return typeof value.provider === 'string' && typeof value.model === 'string'
    ? { provider: value.provider, model: value.model }
    : undefined
}

/** Parse one selector value produced by {@link visualRouteValue}. */
function parseVisualRoute(value: string): { provider: string; model: string } | undefined {
  if (value === '') return undefined
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length !== 2
    || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw new Error('invalid visual model selection')
  }
  return { provider: parsed[0], model: parsed[1] }
}

/** Save or clear only the visual-route fields, preserving deployment limits. */
export async function saveVisualModel(
  api: Pick<IApiClient, 'settings'>,
  namespace: SettingsNamespaceView,
  route: { provider: string; model: string } | undefined,
): Promise<string | undefined> {
  try {
    const response = await api.settings.mutate({
      ns: IMAGE_ANALYSIS_NAMESPACE,
      ops: route === undefined
        ? [
          { op: 'unset' as const, path: ['provider'] },
          { op: 'unset' as const, path: ['model'] },
        ]
        : [
          { op: 'set' as const, path: ['provider'], value: route.provider },
          { op: 'set' as const, path: ['model'], value: route.model },
        ],
      expectedRevision: namespace.revision,
    })
    if (!response.result.ok) return response.result.error.code === 'settings-conflict'
      ? 'settings-conflict'
      : response.result.error.message
  } catch (error) {
    return messageOf(error)
  }
  return undefined
}

/** DeepSeek image-understanding enhancement with revision-checked persistence. */
function DeepSeekImageEnhancement({
  state,
  controller,
  api,
  t,
  deepSeekName,
}: ModelsSectionInjected & { state: ModelsSettingsState; deepSeekName: string }): ReactNode {
  const namespace = state.namespaces.get(IMAGE_ANALYSIS_NAMESPACE)
  const committedValue = visualRouteValue(visualRouteOf(namespace))
  const [value, setValue] = useState(committedValue)
  const [expanded, setExpanded] = useState(committedValue !== '')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const selectId = useId()
  useEffect(() => {
    if (saving) return
    setValue(committedValue)
    setExpanded(committedValue !== '')
  }, [committedValue, saving])
  if (namespace === undefined) return null
  const options = visualModelOptions(state.modelGroups)
  const providers = [...new Map(options.map(option => [option.provider, option.providerName])).entries()]
  const configuredRoute = visualRouteOf(namespace)
  const configuredAvailable = configuredRoute === undefined || options.some(option =>
    option.provider === configuredRoute.provider && option.model === configuredRoute.model)

  const persist = (
    nextValue: string,
    route: { provider: string; model: string } | undefined,
  ): void => {
    setValue(nextValue)
    setSaving(true)
    setFailure(undefined)
    setSaved(false)
    void saveVisualModel(api, namespace, route)
      .then(async (error) => {
        if (error !== undefined) {
          setFailure(error === 'settings-conflict' ? t('conflict') : error)
          setValue(committedValue)
          setExpanded(route !== undefined || committedValue !== '')
          return
        }
        await controller.load()
        setSaved(true)
      })
      .finally(() => { setSaving(false) })
  }

  const select = (nextValue: string): void => {
    let route: { provider: string; model: string } | undefined
    try {
      route = parseVisualRoute(nextValue)
    } catch (error) {
      setFailure(messageOf(error))
      setValue(committedValue)
      return
    }
    /* v8 ignore next -- the disabled placeholder is the only route-less option */
    if (route === undefined) return
    persist(nextValue, route)
  }

  const toggle = (): void => {
    setFailure(undefined)
    setSaved(false)
    if (!expanded) {
      setExpanded(true)
      return
    }
    setExpanded(false)
    if (committedValue === '') {
      setValue('')
      return
    }
    persist('', undefined)
  }

  return (
    <div className={styles['imageEnhancement']}>
      <div className={styles['enhancementHead']}>
        <span className={styles['enhancementCopy']}>
          <span className={styles['enhancementTitle']}>{t('imageUnderstanding')}</span>
          <span className={styles['enhancementDescription']}>{t('imageUnderstandingDescription')}</span>
        </span>
        <button
          type="button"
          className={styles['switch']}
          role="switch"
          aria-label={t('imageUnderstanding')}
          aria-checked={expanded}
          disabled={!state.writable || state.status !== 'ready' || saving}
          onClick={toggle}
        >
          <span className={styles['switchThumb']} aria-hidden="true" />
        </button>
      </div>
      {expanded
        ? (
          <div className={styles['enhancementBody']}>
            <label className={styles['fieldLabel']} htmlFor={selectId}>{t('visionModel')}</label>
            <div className={styles['visionFlow']}>
              <span className={styles['flowEndpoint']}>{t('images')}</span>
              <span className={styles['flowArrow']} aria-hidden="true">&#8594;</span>
              <select
                id={selectId}
                className={`${styles['input']} ${styles['selectInput']} ${styles['visionSelect']}`}
                value={value}
                disabled={!state.writable || state.status !== 'ready' || saving || options.length === 0}
                onChange={(event) => { select(event.target.value) }}
              >
                <option value="" disabled>{t('visionModelChoose')}</option>
                {!configuredAvailable
                  ? (
                    <option value={committedValue} disabled>
                      {t('visionModelUnavailable')}: {configuredRoute.provider} / {configuredRoute.model}
                    </option>
                  )
                  : null}
                {providers.map(([provider, providerName]) => (
                  <optgroup key={provider} label={providerName}>
                    {options.filter(option => option.provider === provider).map(option => (
                      <option key={visualRouteValue(option)} value={visualRouteValue(option)}>
                        {option.modelName === option.model ? option.model : `${option.modelName} (${option.model})`}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span className={styles['flowArrow']} aria-hidden="true">&#8594;</span>
              <span className={styles['flowEndpoint']}>{deepSeekName}</span>
            </div>
            {value === ''
              ? (
                <p className={styles['fieldStatus']}>
                  {options.length === 0 ? t('visionModelEmpty') : t('visionEnhancementPending')}
                </p>
              )
              : null}
          </div>
        )
        : null}
      {saving ? <p className={styles['fieldStatus']} role="status">{t('visionEnhancementSaving')}</p> : null}
      {saved && !saving ? <p className={styles['savedNotice']} role="status">{t('visionEnhancementSaved')}</p> : null}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {expanded && state.modelFailures.length > 0
        ? <p className={styles['notice']}>{t('visionCatalogPartial')}</p>
        : null}
    </div>
  )
}

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditorProps.declared}). */
  declared?: boolean
}

/** Values that vary around the shared provider-editor rendering. */
interface ProviderEditorRenderProps extends Pick<
  ProviderEditorProps,
  'namespace' | 'api' | 't' | 'readOnly' | 'onClose'
> {
  target: EditorTarget
}

/** Render an editor for either the setup posture or an expanded provider row. */
function renderProviderEditor({ target, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...props}
    />
  )
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view.
 * @param api - settings and credential wire faces.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  api: Pick<IApiClient, 'settings' | 'credentials'>,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
): Promise<string | undefined> {
  try {
    if (target.credentialRef !== undefined) {
      const credential = await api.credentials.unset({ ref: target.credentialRef })
      if (!credential.result.ok) return credential.result.error.message
    }
    const response = await api.settings.mutate({
      ns: target.settingsNs,
      ops: [{ op: 'unset', path: [...target.settingsPath] }],
    })
    if (!response.result.ok) return response.result.error.message
  } catch (error) {
    // The transport rejected rather than answering; the caller must be able
    // to retry the idempotent operation instead of the row silently staying.
    return messageOf(error)
  }
  await controller.load()
  return undefined
}

/**
 * Whether a whole-section provider still needs its first key: an unconfigured
 * credential opens the setup card instead of showing a row. This is the
 * first-run posture alone — a user who can already reach some provider gets an
 * ordinary row with the missing-key dot, since nothing here is blocking them.
 * @param row - the joined provider row.
 * @param anyUsable - whether any joined row can already serve requests.
 * @returns whether to render the setup card.
 */
export function needsSetup(row: ProviderRow, anyUsable: boolean): boolean {
  if (anyUsable) return false
  if (row.entry.settingsPath.length > 0) return false
  return row.credential?.configured !== true
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    // Absent is not "shipped": an adapter that answers nothing leaves the
    // route-level fields only a declared route owns off the card, exactly as
    // it leaves the custom tag off the row.
    ...row.entry.declared === true ? { declared: true } : {},
  }
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, t } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || t === undefined) return null
  return <Loaded injected={{ controller, useSnapshot, api, t }} />
}

function Loaded({ injected }: { injected: ModelsSectionInjected }): ReactNode {
  const { controller, api, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [declaring, setDeclaring] = useState(false)
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(() => new Set())

  const announceSaved = (target: ProviderIdentity): void => {
    // Announced only once the refreshed directory is in the snapshot the
    // notice reads its name from: an apply can rename the route, and the
    // target captured when the card opened still carries the old name.
    void controller.load().then(() => { setSavedTarget(target) })
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    setEditing(undefined)
    setAdding(false)
    setDeclaring(false)
    if (changed) announceSaved(target)
  }

  /**
   * Close a setup card, which owns none of the state above: the row-editor,
   * add, and declare cards each own one of those, so clearing them here would
   * discard a draft the user opened beside this card. Dismissal is this card's
   * own — the provider falls back to an ordinary row for the rest of the
   * session, and reopens through Edit.
   */
  const closeSetup = (changed: boolean, target: ProviderIdentity): void => {
    setDismissedSetup(previous => new Set([...previous, target.provider]))
    if (changed) announceSaved(target)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(api, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  // One fact decides both first-run postures on this page and the onboarding
  // step: whether the user already has a provider to talk to.
  const anyUsable = state.rows.some(providerUsable)
  const configured = state.rows.filter(row => row.configured)
  const addable = state.rows.filter(row => !row.configured && row.entry.settingsNs !== '')
  const addTarget = adding ? editing : undefined
  const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)
  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the entry point stays disabled.
  const protocols = protocolChoices(state.namespaces.get('llm-pi-ai'))

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}
      <ul className={styles['rows']}>
        {configured.map((row) => {
          const target = targetOf(row)
          const namespace = state.namespaces.get(target.settingsNs)
          /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
          if (namespace === undefined) return null
          const isDeepSeek = row.entry.provider === 'deepseek-official'
            && row.entry.settingsNs === 'llm-deepseek'
          if (needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider)) {
            // First-run posture: the provider exists but has no key — the
            // setup card IS its presence on the page, until the user closes it.
            return (
              <li key={row.entry.provider} className={styles['setupCard']}>
                {renderProviderEditor({
                  target,
                  namespace,
                  api,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeSetup(changed, target) },
                })}
                {isDeepSeek
                  ? (
                    <DeepSeekImageEnhancement
                      state={state}
                      controller={controller}
                      useSnapshot={injected.useSnapshot}
                      api={api}
                      t={t}
                      deepSeekName={row.entry.displayName}
                    />
                  )
                  : null}
              </li>
            )
          }
          const open = !adding && editing?.provider === row.entry.provider
          const credentialConfigured = row.credential?.configured === true
          const credentialMissing = !credentialConfigured
            && row.apiKeyEnv !== undefined
            && row.credential?.configured === false
          return (
            <li key={row.entry.provider} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowMain']}>
                  <span className={styles['rowIdentity']}>
                    <span className={styles['rowName']}>{row.entry.displayName}</span>
                    {/* Only the adapter can tell a hand-declared route from a
                        shipped one it also has a stored profile for, so the tag
                        follows its answer and stays off when it gives none. */}
                    {row.entry.declared === true
                      ? <span className={styles['rowTag']}>{t('customTag')}</span>
                      : null}
                    {credentialConfigured
                      ? (
                        <span
                          className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
                          role="img"
                          aria-label={t('credentialConfigured')}
                          title={t('credentialConfigured')}
                        />
                      )
                      : credentialMissing
                        ? (
                          <span
                            className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                            role="img"
                            aria-label={t('credentialMissing')}
                            title={t('credentialMissing')}
                          />
                        )
                        : null}
                  </span>
                  {isDeepSeek
                    ? <span className={styles['primaryDescription']}>{t('deepSeekPrimary')}</span>
                    : null}
                </span>
                <span className={styles['rowActions']}>
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    aria-label={providerCopy(t('editProvider'), target)}
                    onClick={() => {
                      setSavedTarget(undefined)
                      // One card at a time: leaving `declaring` set would show
                      // the create card beside this editor, and closing either
                      // one discards the other's draft.
                      setDeclaring(false)
                      setAdding(false)
                      setEditing(open ? undefined : target)
                    }}
                  >
                    {t('edit')}
                  </button>
                  {row.removable
                    ? (
                      <button
                        type="button"
                        className={styles['dangerButton']}
                        aria-label={providerCopy(t('removeProvider'), target)}
                        disabled={!state.writable}
                        onClick={() => {
                          setSavedTarget(undefined)
                          setDeleteFailure(undefined)
                          setDeleteTarget(target)
                        }}
                      >
                        {t('remove')}
                      </button>
                    )
                    : null}
                </span>
              </div>
              {isDeepSeek
                ? (
                  <DeepSeekImageEnhancement
                    state={state}
                    controller={controller}
                    useSnapshot={injected.useSnapshot}
                    api={api}
                    t={t}
                    deepSeekName={row.entry.displayName}
                  />
                )
                : null}
              {open
                ? renderProviderEditor({
                  target,
                  namespace,
                  api,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => { closeEditor(changed, target) },
                })
                : null}
            </li>
          )
        })}
      </ul>
      <div className={styles['addBlock']}>
        {addTarget !== undefined && addNamespace !== undefined
          ? (
            <div className={styles['addCard']}>
              <div className={styles['field']}>
                <span className={styles['fieldLabel']}>{t('provider')}</span>
                <select
                  className={`${styles['input']} ${styles['selectInput']}`}
                  value={addTarget.provider}
                  aria-label={t('provider')}
                  onChange={(event) => {
                    const row = addable.find(candidate => candidate.entry.provider === event.target.value)
                    /* v8 ignore next -- the select only lists addable rows */
                    if (row === undefined) return
                    setEditing(targetOf(row))
                  }}
                >
                  {addable.map(row => (
                    <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>
                  ))}
                </select>
              </div>
              <ProviderEditor
                key={addTarget.provider}
                provider={addTarget.provider}
                displayName={addTarget.displayName}
                hideTitle
                namespace={addNamespace}
                settingsPath={addTarget.settingsPath}
                api={api}
                t={t}
                readOnly={!state.writable}
                onClose={(changed) => { closeEditor(changed, addTarget) }}
              />
            </div>
          )
          : declaring
            ? (
              <div className={styles['addCard']}>
                <CustomProviderCard
                  taken={state.rows.map(row => row.entry.provider)}
                  protocols={protocols}
                  /* v8 ignore next -- the card only opens from a button disabled without this namespace */
                  revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0}
                  api={api}
                  t={t}
                  readOnly={!state.writable}
                  onClose={(changed) => {
                    setDeclaring(false)
                    if (changed) void controller.load()
                  }}
                />
              </div>
            )
            : (
              // One row for the two ways to gain a provider: adopt one the
              // adapter already knows, or declare one it does not. Side by side
              // and equal-width so they read as siblings and line up with the
              // rows above, rather than two pills of different lengths.
              <div className={styles['addActions']}>
                <button
                  type="button"
                  className={styles['addButton']}
                  disabled={addable.length === 0 || !state.writable}
                  onClick={() => {
                    const first = addable[0]
                    /* v8 ignore next -- the button is disabled while nothing is addable */
                    if (first === undefined) return
                    setSavedTarget(undefined)
                    setDeclaring(false)
                    setAdding(true)
                    setEditing(targetOf(first))
                  }}
                >
                  {/* Same glyph as the composer's attach button. */}
                  <IconPlusOutline16 size={14} />
                  {t('add')}
                </button>
                <button
                  type="button"
                  className={styles['addButton']}
                  disabled={protocols.length === 0 || !state.writable}
                  onClick={() => {
                    setSavedTarget(undefined)
                    setAdding(false)
                    setEditing(undefined)
                    setDeclaring(true)
                  }}
                >
                  <IconPlusOutline16 size={14} />
                  {t('customAdd')}
                </button>
              </div>
            )}
      </div>
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            deleteTarget.credentialRef === undefined
              ? t('deleteDescription')
              : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
