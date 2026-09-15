import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLlmModels } from '../lib/tauri'

type ModelDiscoveryStatus = 'idle' | 'loading' | 'success' | 'error'

interface ModelDiscoveryState {
  models: string[]
  status: ModelDiscoveryStatus
  error: string | null
}

const IDLE_STATE: ModelDiscoveryState = {
  models: [],
  status: 'idle',
  error: null,
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim()
}

function sanitizeErrorMessage(error: unknown, apiKey: string): string {
  const rawMessage = (error instanceof Error ? error.message : String(error ?? 'Unknown error')).trim()
  const trimmedApiKey = apiKey.trim()
  const redactedMessage =
    trimmedApiKey.length > 0 ? rawMessage.split(trimmedApiKey).join('[REDACTED]') : rawMessage

  if (redactedMessage.length <= 300) {
    return redactedMessage || 'Unknown error'
  }

  return `${redactedMessage.slice(0, 297).trimEnd()}...`
}

export function useAgentMaestroModels(baseUrl: string, apiKey: string, enabled: boolean) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const [, setVersion] = useState(0)
  const cacheRef = useRef(new Map<string, ModelDiscoveryState>())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const latestRequestIdRef = useRef(0)
  const apiKeyRevisionRef = useRef(0)
  const lastApiKeyRef = useRef(apiKey)
  const scopeRef = useRef({ key: '', serial: 0 })

  if (lastApiKeyRef.current !== apiKey) {
    lastApiKeyRef.current = apiKey
    apiKeyRevisionRef.current += 1
  }

  const scopeKey = `${enabled ? 'enabled' : 'disabled'}:${normalizedBaseUrl}:${apiKeyRevisionRef.current}`
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = {
      key: scopeKey,
      serial: scopeRef.current.serial + 1,
    }
  }

  const forceRender = useCallback(() => {
    setVersion((value) => value + 1)
  }, [])

  const updateScopeState = useCallback(
    (targetScopeKey: string, updater: (previous: ModelDiscoveryState) => ModelDiscoveryState) => {
      const previous = cacheRef.current.get(targetScopeKey) ?? IDLE_STATE
      cacheRef.current.set(targetScopeKey, updater(previous))
      forceRender()
    },
    [forceRender],
  )

  const refresh = useCallback(async () => {
    if (!enabled || !normalizedBaseUrl) {
      return
    }

    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId
    const requestScopeKey = scopeKey
    const requestScopeSerial = scopeRef.current.serial

    updateScopeState(requestScopeKey, (previous) => ({
      models: previous.models,
      status: 'loading',
      error: null,
    }))

    try {
      const models = await fetchLlmModels(apiKey, 'agent-maestro', normalizedBaseUrl)

      if (
        !mountedRef.current ||
        latestRequestIdRef.current !== requestId ||
        scopeRef.current.serial !== requestScopeSerial
      ) {
        return
      }

      updateScopeState(requestScopeKey, () => ({
        models,
        status: 'success',
        error: null,
      }))
    } catch (error) {
      if (
        !mountedRef.current ||
        latestRequestIdRef.current !== requestId ||
        scopeRef.current.serial !== requestScopeSerial
      ) {
        return
      }

      updateScopeState(requestScopeKey, (previous) => ({
        models: previous.models,
        status: 'error',
        error: sanitizeErrorMessage(error, apiKey),
      }))
    }
  }, [apiKey, enabled, normalizedBaseUrl, scopeKey, updateScopeState])

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    if (!enabled || !normalizedBaseUrl) {
      return
    }

    debounceRef.current = setTimeout(() => {
      void refresh()
    }, 500)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [enabled, normalizedBaseUrl, refresh, scopeKey])

  const currentState = cacheRef.current.get(scopeKey) ?? IDLE_STATE

  return {
    ...currentState,
    refresh,
  }
}
