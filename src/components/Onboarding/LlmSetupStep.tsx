import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore, type LlmProvider } from '../../stores/appStore'
import {
  LLM_DEFAULT_CONFIG,
  AZURE_OPENAI_PROVIDER,
  ONBOARDING_LLM_PROVIDERS,
  llmProviderRequiresApiKey,
} from '../../lib/constants'
import { testLlmConnection, fetchLlmModels } from '../../lib/tauri'
import { AzureOpenAiFields } from '../AzureOpenAiFields'
import { useProviderCredential } from '../../hooks/useProviderCredential'
import { CheckCircle2, XCircle, Loader2, RefreshCw } from 'lucide-react'
import { AgentMaestroFields } from '../AgentMaestroFields'

export function LlmSetupStep() {
  const { t } = useTranslation()
  const config = useAppStore((s) => s.config)
  const updateConfig = useAppStore((s) => s.updateConfig)
  const llmTestStatus = useAppStore((s) => s.llmTestStatus)
  const setLlmTestStatus = useAppStore((s) => s.setLlmTestStatus)

  const [models, setModels] = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fallbackProvider =
    (ONBOARDING_LLM_PROVIDERS[0]?.value as LlmProvider | undefined) ?? 'zhipu'
  const selectedProvider: LlmProvider = ONBOARDING_LLM_PROVIDERS.some(
    (provider) => provider.value === config.llm_provider,
  )
    ? config.llm_provider
    : fallbackProvider
  const requiresApiKey = llmProviderRequiresApiKey(selectedProvider)
  const isMaestro = selectedProvider === 'agent-maestro'
  const isAzure = selectedProvider === AZURE_OPENAI_PROVIDER
  const credential = useProviderCredential('llm', selectedProvider, '', isAzure)
  const apiKey = isAzure ? credential.value : config.llm_api_key
  const [testErrorMessage, setTestErrorMessage] = useState<string | null>(null)
  const modelRequest = useRef(0)
  const testRequest = useRef(0)
  const testPending = useRef(false)
  const azureReady = Boolean(
    config.llm_base_url.trim() && config.llm_model.trim() && config.llm_azure_api_version?.trim(),
  )

  useEffect(() => {
    modelRequest.current += 1
    setModels([])
    setFetchingModels(false)
    return () => {
      modelRequest.current += 1
    }
  }, [selectedProvider, config.llm_base_url, apiKey])

  useLayoutEffect(() => {
    testRequest.current += 1
    if (isMaestro) {
      testPending.current = false
      return
    }
    if (isAzure) setLlmTestStatus('idle')
    return () => {
      testRequest.current += 1
      if (testPending.current) {
        testPending.current = false
        setLlmTestStatus('idle')
      }
    }
  }, [
    selectedProvider,
    config.llm_base_url,
    config.llm_model,
    config.llm_azure_api_version,
    apiKey,
    isAzure,
    isMaestro,
    setLlmTestStatus,
  ])

  useEffect(() => {
    if (selectedProvider === config.llm_provider) return
    const defaults = LLM_DEFAULT_CONFIG[selectedProvider]
    updateConfig({
      llm_provider: selectedProvider,
      llm_base_url: defaults?.baseUrl ?? config.llm_base_url,
      llm_model: defaults?.model ?? config.llm_model,
    })
    setLlmTestStatus('idle')
    setModels([])
  }, [
    config.llm_base_url,
    config.llm_model,
    config.llm_provider,
    selectedProvider,
    setLlmTestStatus,
    updateConfig,
  ])

  const doFetchModels = useCallback(async (apiKey: string, provider: string, baseUrl: string) => {
    if (!baseUrl || provider === AZURE_OPENAI_PROVIDER || provider === 'agent-maestro') return
    const request = ++modelRequest.current
    setFetchingModels(true)
    try {
      const list = await fetchLlmModels(apiKey, provider, baseUrl)
      if (request === modelRequest.current) setModels(list)
    } catch {
      if (request === modelRequest.current) setModels([])
    } finally {
      if (request === modelRequest.current) setFetchingModels(false)
    }
  }, [])

  // Auto-fetch when API key changes (debounced)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (isAzure || isMaestro || (requiresApiKey && !apiKey) || !config.llm_base_url) return
    debounceRef.current = setTimeout(() => {
      doFetchModels(apiKey, selectedProvider, config.llm_base_url)
    }, 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [
    apiKey,
    config.llm_base_url,
    doFetchModels,
    requiresApiKey,
    selectedProvider,
    isAzure,
    isMaestro,
  ])

  const handleTest = async () => {
    if (isMaestro) return
    const request = ++testRequest.current
    testPending.current = true
    setLlmTestStatus('testing')
    setTestErrorMessage(null)
    try {
      if (isAzure) await credential.flush()
      if (request !== testRequest.current) return
      const ok = await testLlmConnection(
        apiKey,
        selectedProvider,
        config.llm_base_url,
        config.llm_model,
        ...(isAzure ? [config.llm_azure_api_version] : []),
      )
      if (request !== testRequest.current) return
      testPending.current = false
      setLlmTestStatus(ok ? 'success' : 'error')
    } catch (error) {
      if (request !== testRequest.current) return
      testPending.current = false
      setTestErrorMessage(error instanceof Error ? error.message : String(error))
      setLlmTestStatus('error')
    }
  }

  return (
    <div className="space-y-5">
      <Field label={t('onboarding.llm.serviceLabel')}>
        <select
          value={selectedProvider}
          onChange={(e) => {
            const provider = e.target.value as typeof config.llm_provider
            const defaults = LLM_DEFAULT_CONFIG[provider]
            modelRequest.current += 1
            testRequest.current += 1
            testPending.current = false
            updateConfig({
              llm_provider: provider,
              ...(provider === 'agent-maestro' ? { llm_api_key: '' } : {}),
              llm_base_url: defaults?.baseUrl ?? config.llm_base_url,
              llm_model: defaults?.model ?? config.llm_model,
              ...(isAzure || provider === AZURE_OPENAI_PROVIDER ? { llm_api_key: '' } : {}),
            })
            setLlmTestStatus('idle')
            setTestErrorMessage(null)
            setModels([])
          }}
          className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus transition-colors"
        >
          {ONBOARDING_LLM_PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {t(p.labelKey)}
            </option>
          ))}
        </select>
      </Field>

      {isMaestro && <AgentMaestroFields mode="onboarding" />}

      {requiresApiKey && !isMaestro && (
        <Field label={t('onboarding.llm.apiKeyLabel')}>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                if (isAzure) {
                  credential.setValue(e.target.value)
                  credential.persist(e.target.value)
                } else {
                  updateConfig({ llm_api_key: e.target.value })
                }
                setLlmTestStatus('idle')
                setTestErrorMessage(null)
              }}
              onBlur={() => {
                if (isAzure) credential.persist(apiKey, 0)
              }}
              placeholder={t('onboarding.llm.apiKeyPlaceholder')}
              className="flex-1 px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus transition-colors"
            />
            <button
              onClick={handleTest}
              disabled={
                !apiKey.trim() ||
                llmTestStatus === 'testing' ||
                (isAzure && (!azureReady || !!credential.error))
              }
              className="px-4 py-2.5 bg-accent text-white rounded-[10px] text-[13px] border-none cursor-pointer hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            >
              {llmTestStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
              {t('onboarding.llm.testButton')}
            </button>
          </div>
          <TestStatusHint status={llmTestStatus} />
          {testErrorMessage && <p className="text-[12px] text-error mt-2">{testErrorMessage}</p>}
          {credential.error && <p className="text-[12px] text-error mt-2">{credential.error}</p>}
        </Field>
      )}

      {isAzure ? (
        <AzureOpenAiFields
          value={{
            endpoint: config.llm_base_url,
            deployment: config.llm_model,
            apiVersion: config.llm_azure_api_version,
          }}
          onChange={(patch) => {
            updateConfig({
              ...(patch.endpoint !== undefined ? { llm_base_url: patch.endpoint } : {}),
              ...(patch.deployment !== undefined ? { llm_model: patch.deployment } : {}),
              ...(patch.apiVersion !== undefined
                ? { llm_azure_api_version: patch.apiVersion }
                : {}),
            })
            setLlmTestStatus('idle')
            setTestErrorMessage(null)
          }}
        />
      ) : !isMaestro ? (
        <>
          <Field label={t('onboarding.llm.modelLabel')}>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  list="onboarding-llm-model-list"
                  value={config.llm_model}
                  onChange={(e) => {
                    updateConfig({ llm_model: e.target.value })
                    setLlmTestStatus('idle')
                    setTestErrorMessage(null)
                  }}
                  placeholder={t('onboarding.llm.modelPlaceholder')}
                  className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus transition-colors"
                />
                <datalist id="onboarding-llm-model-list">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <button
                onClick={() =>
                  doFetchModels(config.llm_api_key, selectedProvider, config.llm_base_url)
                }
                disabled={
                  fetchingModels || !config.llm_base_url || (requiresApiKey && !config.llm_api_key)
                }
                className="px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-secondary cursor-pointer hover:border-border-focus disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                title={t('onboarding.llm.fetchModelsTitle')}
              >
                <RefreshCw size={14} className={fetchingModels ? 'animate-spin' : ''} />
              </button>
            </div>
            {models.length > 0 && (
              <p className="text-[11px] text-text-tertiary mt-1">
                {t('onboarding.llm.modelsAvailable', { count: models.length })}
              </p>
            )}
          </Field>

          <Field label={t('onboarding.llm.baseUrlLabel')}>
            <div className="flex gap-2">
              <input
                value={config.llm_base_url}
                onChange={(e) => {
                  updateConfig({ llm_base_url: e.target.value })
                  setLlmTestStatus('idle')
                  setTestErrorMessage(null)
                }}
                placeholder={
                  LLM_DEFAULT_CONFIG[selectedProvider]?.baseUrl ?? 'https://api.openai.com/v1'
                }
                className="min-w-0 flex-1 px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus transition-colors"
              />
              {!requiresApiKey && (
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={!config.llm_base_url || llmTestStatus === 'testing'}
                  className="px-4 py-2.5 bg-accent text-white rounded-[10px] text-[13px] border-none cursor-pointer hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                >
                  {llmTestStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
                  {t('onboarding.llm.testButton')}
                </button>
              )}
            </div>
            {!requiresApiKey && <TestStatusHint status={llmTestStatus} />}
          </Field>
        </>
      ) : null}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-text-secondary mb-2">{label}</label>
      {children}
    </div>
  )
}

function TestStatusHint({ status }: { status: string }) {
  const { t } = useTranslation()
  if (status === 'success') {
    return (
      <p className="flex items-center gap-1 text-[12px] text-success mt-2">
        <CheckCircle2 size={13} /> {t('onboarding.llm.connectionOk')}
      </p>
    )
  }
  if (status === 'error') {
    return (
      <p className="flex items-center gap-1 text-[12px] text-error mt-2">
        <XCircle size={13} /> {t('onboarding.llm.connectionFail')}
      </p>
    )
  }
  return null
}
