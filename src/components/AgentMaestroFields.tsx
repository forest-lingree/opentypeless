import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { useAgentMaestroCredential } from '../hooks/useAgentMaestroCredential'
import { useAgentMaestroModels } from '../hooks/useAgentMaestroModels'
import { benchLlmConnection, testLlmConnection } from '../lib/tauri'
import { useAppStore } from '../stores/appStore'

interface AgentMaestroFieldsProps {
  mode: 'settings' | 'onboarding'
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:23333/api/openai/v1'

function boundedError(error: unknown, apiKey: string, fallback: string): string {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const redacted = apiKey ? detail.split(apiKey).join('[REDACTED]') : detail
  const message = redacted.trim() ? `${fallback}: ${redacted.trim()}` : fallback
  return message.length <= 300 ? message : `${message.slice(0, 297).trimEnd()}...`
}

export function AgentMaestroFields({ mode }: AgentMaestroFieldsProps) {
  const { t } = useTranslation()
  const config = useAppStore((state) => state.config)
  const updateConfig = useAppStore((state) => state.updateConfig)
  const llmTestStatus = useAppStore((state) => state.llmTestStatus)
  const setLlmTestStatus = useAppStore((state) => state.setLlmTestStatus)
  const llmLatencyMs = useAppStore((state) => state.llmLatencyMs)
  const setLlmLatencyMs = useAppStore((state) => state.setLlmLatencyMs)
  const [testError, setTestError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)
  const credentialValueRef = useRef('')
  const previousScopeRef = useRef<string | null>(null)
  const keyId = useId()
  const modelId = useId()
  const baseUrlId = useId()
  const modelListId = useId()
  const isMaestro = config.llm_provider === 'agent-maestro'

  const clearMigratedLegacyKey = useCallback((legacyKey: string) => {
    const state = useAppStore.getState()
    if (state.config.llm_provider === 'agent-maestro' && state.config.llm_api_key === legacyKey) {
      state.updateConfig({ llm_api_key: '' })
    }
  }, [])

  const credential = useAgentMaestroCredential(
    isMaestro ? config.llm_api_key : '',
    clearMigratedLegacyKey,
  )
  credentialValueRef.current = credential.value

  const trimmedBaseUrl = config.llm_base_url.trim()
  const trimmedModel = config.llm_model.trim()
  const credentialReady = credential.status === 'ready'
  const models = useAgentMaestroModels(
    config.llm_base_url,
    credential.value,
    isMaestro && credentialReady,
  )

  const invalidateTest = useCallback(() => {
    requestRef.current += 1
    setTestError(null)
    const state = useAppStore.getState()
    if (state.config.llm_provider !== 'agent-maestro') return
    state.setLlmTestStatus('idle')
    state.setLlmLatencyMs(null)
  }, [])

  const scope = [
    config.llm_provider,
    config.llm_base_url,
    config.llm_model,
    credential.value,
    credential.status,
  ].join('\u0000')

  useLayoutEffect(() => {
    if (previousScopeRef.current === null) {
      previousScopeRef.current = scope
      return
    }
    if (previousScopeRef.current === scope) return
    previousScopeRef.current = scope
    invalidateTest()
  }, [invalidateTest, scope])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [])

  const handleTest = async () => {
    if (!isMaestro || !credentialReady || !trimmedBaseUrl || !trimmedModel) return

    const requestId = requestRef.current + 1
    requestRef.current = requestId
    const requestKey = credential.value
    const requestBaseUrl = config.llm_base_url
    const requestModel = config.llm_model
    setTestError(null)
    setLlmLatencyMs(null)
    setLlmTestStatus('testing')

    const isCurrent = () => {
      const current = useAppStore.getState().config
      return (
        mountedRef.current &&
        requestRef.current === requestId &&
        current.llm_provider === 'agent-maestro' &&
        current.llm_base_url === requestBaseUrl &&
        current.llm_model === requestModel &&
        credentialValueRef.current === requestKey
      )
    }

    try {
      if (mode === 'settings') {
        const latency = await benchLlmConnection(
          requestKey,
          'agent-maestro',
          trimmedBaseUrl,
          trimmedModel,
        )
        if (!isCurrent()) return
        setLlmLatencyMs(latency)
        setLlmTestStatus('success')
      } else {
        const succeeded = await testLlmConnection(
          requestKey,
          'agent-maestro',
          trimmedBaseUrl,
          trimmedModel,
        )
        if (!isCurrent()) return
        if (succeeded) {
          setLlmTestStatus('success')
        } else {
          setTestError(t('settings.connectionFailed'))
          setLlmTestStatus('error')
        }
      }
    } catch (caught) {
      if (!isCurrent()) return
      setTestError(boundedError(caught, requestKey, t('settings.connectionFailed')))
      setLlmTestStatus('error')
    }
  }

  const configurationMissing = !trimmedBaseUrl || !trimmedModel
  const credentialPending = credential.status === 'loading' || credential.status === 'saving'
  const operationsBlocked = !isMaestro || !credentialReady
  const testDisabled = operationsBlocked || configurationMissing || llmTestStatus === 'testing'
  const refreshDisabled = operationsBlocked || !trimmedBaseUrl || models.status === 'loading'

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-secondary">{t('settings.agentMaestroHint')}</p>

      <Field
        htmlFor={keyId}
        label={`${t('settings.apiKey')} (${t('settings.agentMaestroKeyOptional')})`}
      >
        <input
          id={keyId}
          type="password"
          value={credential.value}
          disabled={credential.status === 'loading' || credential.readFailed}
          onChange={(event) => {
            credential.update(event.target.value)
            invalidateTest()
          }}
          onBlur={credential.flush}
          className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus transition-colors disabled:opacity-50"
        />
        {credential.status === 'error' && (
          <div className="flex items-center gap-2 mt-1.5">
            <p className="text-[11px] text-error">{t('settings.agentMaestroCredentialError')}</p>
            <button
              type="button"
              onClick={credential.retry}
              className="text-[11px] text-accent cursor-pointer"
            >
              {t('settings.agentMaestroRetry')}
            </button>
          </div>
        )}
      </Field>

      <Field htmlFor={modelId} label={t('settings.model')}>
        <div className="flex gap-2">
          <input
            id={modelId}
            list={modelListId}
            value={config.llm_model}
            onChange={(event) => {
              updateConfig({ llm_model: event.target.value })
              invalidateTest()
            }}
            className="min-w-0 flex-1 px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus transition-colors"
          />
          <datalist id={modelListId}>
            {models.models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <button
            type="button"
            aria-label={t('settings.fetchModels')}
            title={t('settings.fetchModels')}
            onClick={() => void models.refresh()}
            disabled={refreshDisabled}
            className="px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-secondary cursor-pointer hover:border-border-focus disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={14} className={models.status === 'loading' ? 'animate-spin' : ''} />
          </button>
        </div>
        {models.status === 'loading' && (
          <p className="text-[11px] text-text-tertiary mt-1">
            {t('settings.agentMaestroModelsLoading')}
          </p>
        )}
        {models.status === 'success' && models.models.length === 0 && (
          <p className="text-[11px] text-text-tertiary mt-1">
            {t('settings.agentMaestroModelsEmpty')}
          </p>
        )}
        {models.models.length > 0 && (
          <p className="text-[11px] text-text-tertiary mt-1">
            {t('settings.modelsAvailable', { count: models.models.length })}
          </p>
        )}
        {models.status === 'error' && (
          <p className="text-[11px] text-error mt-1">
            {boundedError(models.error, credential.value, t('settings.connectionFailed'))}
          </p>
        )}
      </Field>

      <Field htmlFor={baseUrlId} label={t('settings.baseUrl')}>
        <input
          id={baseUrlId}
          value={config.llm_base_url}
          onChange={(event) => {
            updateConfig({ llm_base_url: event.target.value })
            invalidateTest()
          }}
          placeholder={DEFAULT_BASE_URL}
          className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus transition-colors"
        />
      </Field>

      {configurationMissing && (
        <p className="text-[12px] text-error">{t('settings.agentMaestroConfigurationRequired')}</p>
      )}
      {credentialPending && (
        <p className="text-[12px] text-text-tertiary">
          {t('settings.agentMaestroCredentialPending')}
        </p>
      )}

      <button
        type="button"
        onClick={() => void handleTest()}
        disabled={testDisabled}
        className="px-4 py-2.5 bg-accent text-white rounded-[10px] text-[13px] border-none cursor-pointer hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
      >
        {llmTestStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
        {t('settings.test')}
      </button>

      {llmTestStatus === 'success' && (
        <p className="flex items-center gap-1 text-[12px] text-success">
          <CheckCircle2 size={13} />
          {mode === 'settings' && llmLatencyMs !== null
            ? `${llmLatencyMs}ms`
            : t('settings.connectionSuccess')}
        </p>
      )}
      {(llmTestStatus === 'error' || testError) && (
        <p
          data-testid="agent-maestro-test-error"
          className="flex items-center gap-1 text-[12px] text-error"
        >
          <XCircle size={13} />
          {testError ?? t('settings.connectionFailed')}
        </p>
      )}
    </div>
  )
}

function Field({
  htmlFor,
  label,
  children,
}: {
  htmlFor: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-text-secondary mb-2">
        {label}
      </label>
      {children}
    </div>
  )
}
