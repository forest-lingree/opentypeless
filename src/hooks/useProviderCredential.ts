import { useCallback, useEffect, useRef, useState } from 'react'
import { AZURE_OPENAI_PROVIDER } from '../lib/constants'
import { readCredential, setCredential } from '../lib/tauri'

// Keep writes ordered even when a provider's form unmounts and is opened again.
const credentialWrites = new Map<string, Promise<void>>()

export function useProviderCredential(
  namespace: 'stt' | 'llm',
  provider: string,
  legacyKey = '',
  enabled = true,
) {
  const initialProvider = useRef(provider)
  const scope = `${namespace}:${provider}`
  const fallback =
    provider === initialProvider.current && provider !== AZURE_OPENAI_PROVIDER ? legacyKey : ''
  const [draft, setDraft] = useState({ provider, value: enabled ? fallback : '' })
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduledSave = useRef<(() => void) | null>(null)
  const revision = useRef(0)
  const dirty = useRef(false)
  const generation = useRef(0)
  const pending = useRef<Promise<void>>(Promise.resolve())
  const value = draft.provider === provider && enabled ? draft.value : ''

  useEffect(() => {
    generation.current += 1
    const currentGeneration = generation.current
    const readRevision = revision.current
    dirty.current = false
    pending.current = Promise.resolve()
    setDraft({ provider, value: enabled ? fallback : '' })
    setError(null)
    if (enabled) {
      Promise.resolve(credentialWrites.get(scope))
        .catch(() => {})
        .then(() => readCredential(namespace, provider))
        .then((secret) => {
          if (generation.current === currentGeneration && revision.current === readRevision) {
            setDraft({ provider, value: fallback || secret || '' })
          }
        })
        .catch((reason) => {
          if (generation.current === currentGeneration && revision.current === readRevision) {
            setError(reason instanceof Error ? reason.message : String(reason))
          }
        })
    }
    return () => {
      generation.current += 1
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      scheduledSave.current?.()
    }
  }, [enabled, fallback, namespace, provider, scope])

  const setValue = useCallback(
    (next: string) => {
      revision.current++
      dirty.current = true
      setDraft({ provider, value: next })
      setError(null)
    },
    [provider],
  )

  const save = useCallback(
    (next: string, saveGeneration = generation.current, saveRevision = revision.current) => {
      const operation = Promise.resolve(credentialWrites.get(scope))
        .catch(() => {})
        .then(() => setCredential(namespace, provider, next))
      credentialWrites.set(scope, operation)
      void operation
        .finally(() => {
          if (credentialWrites.get(scope) === operation) credentialWrites.delete(scope)
        })
        .catch(() => {})
      pending.current = operation
      return operation
        .then(() => {
          if (generation.current === saveGeneration && revision.current === saveRevision) {
            dirty.current = false
            setError(null)
          }
        })
        .catch((reason) => {
          if (generation.current === saveGeneration && revision.current === saveRevision) {
            setError(reason instanceof Error ? reason.message : String(reason))
          }
          throw reason
        })
    },
    [namespace, provider, scope],
  )

  const persist = useCallback(
    (next: string, delayMs = 350) => {
      if (!enabled || !dirty.current) return
      if (timer.current) clearTimeout(timer.current)
      const saveGeneration = generation.current
      const saveRevision = revision.current
      scheduledSave.current = () => {
        timer.current = null
        scheduledSave.current = null
        void save(next, saveGeneration, saveRevision).catch(() => {})
      }
      timer.current = setTimeout(scheduledSave.current, delayMs)
    },
    [enabled, save],
  )

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    scheduledSave.current = null
    if (enabled && dirty.current) await save(value)
    else await (credentialWrites.get(scope) ?? pending.current)
  }, [enabled, save, scope, value])

  return { value, setValue, error, setError, persist, flush }
}
