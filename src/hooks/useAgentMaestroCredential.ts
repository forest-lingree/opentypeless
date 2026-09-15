import { useCallback, useEffect, useRef, useState } from 'react'
import { readCredential, setCredential } from '../lib/tauri'

export type AgentMaestroCredentialStatus = 'loading' | 'saving' | 'ready' | 'error'

const READ_ERROR = 'Unable to load the Agent Maestro credential.'
const SAVE_ERROR = 'Unable to save the Agent Maestro credential.'

let credentialWriteQueue: Promise<void> = Promise.resolve()

function enqueueCredentialWrite(value: string): Promise<void> {
  const persist = () => setCredential('llm', 'agent-maestro', value)
  const operation = credentialWriteQueue.then(persist, persist)
  credentialWriteQueue = operation
  return operation
}

async function waitForCredentialWrites(): Promise<void> {
  await credentialWriteQueue.catch(() => undefined)
}

export function useAgentMaestroCredential(
  legacyKey: string,
  onLegacySaved: (legacyKey: string) => void,
) {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<AgentMaestroCredentialStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const valueRef = useRef('')
  const revisionRef = useRef(0)
  const queuedRevisionRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failedOperationRef = useRef<'read' | 'write' | null>(null)
  const readAttemptRef = useRef(0)
  const legacyKeyRef = useRef(legacyKey)
  const onLegacySavedRef = useRef(onLegacySaved)
  const flushRef = useRef<() => void>(() => undefined)

  legacyKeyRef.current = legacyKey
  onLegacySavedRef.current = onLegacySaved

  const save = useCallback((revision: number, nextValue: string, force = false) => {
    if (!force && revision <= queuedRevisionRef.current) return
    queuedRevisionRef.current = Math.max(queuedRevisionRef.current, revision)
    failedOperationRef.current = null
    if (mountedRef.current) {
      setStatus('saving')
      setError(null)
    }

    const legacyAtSave = legacyKeyRef.current
    void enqueueCredentialWrite(nextValue).then(
      () => {
        if (legacyAtSave) onLegacySavedRef.current(legacyAtSave)
        if (!mountedRef.current || revision !== revisionRef.current) return
        failedOperationRef.current = null
        setStatus('ready')
        setError(null)
      },
      () => {
        if (!mountedRef.current || revision !== revisionRef.current) {
          console.error('[credentials] failed to save Agent Maestro credential')
          return
        }
        failedOperationRef.current = 'write'
        setStatus('error')
        setError(SAVE_ERROR)
      },
    )
  }, [])

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (revisionRef.current > queuedRevisionRef.current) {
      save(revisionRef.current, valueRef.current)
    }
  }, [save])
  flushRef.current = flush

  const load = useCallback(async () => {
    const attempt = readAttemptRef.current + 1
    readAttemptRef.current = attempt
    const startingRevision = revisionRef.current
    failedOperationRef.current = null
    if (mountedRef.current) {
      setStatus('loading')
      setError(null)
    }

    try {
      await waitForCredentialWrites()
      const storedValue = await readCredential('llm', 'agent-maestro')
      if (
        !mountedRef.current ||
        readAttemptRef.current !== attempt ||
        revisionRef.current !== startingRevision
      ) {
        return
      }

      const currentLegacyKey = legacyKeyRef.current
      if (!currentLegacyKey.trim()) {
        valueRef.current = storedValue ?? ''
        setValue(storedValue ?? '')
        setStatus('ready')
        return
      }

      valueRef.current = currentLegacyKey
      setValue(currentLegacyKey)
      revisionRef.current += 1
      save(revisionRef.current, currentLegacyKey)
    } catch {
      if (
        !mountedRef.current ||
        readAttemptRef.current !== attempt ||
        revisionRef.current !== startingRevision
      ) {
        return
      }
      failedOperationRef.current = 'read'
      setStatus('error')
      setError(READ_ERROR)
    }
  }, [save])

  useEffect(() => {
    mountedRef.current = true
    void load()

    return () => {
      mountedRef.current = false
      flushRef.current()
    }
  }, [load])

  const update = useCallback(
    (nextValue: string) => {
      valueRef.current = nextValue
      revisionRef.current += 1
      failedOperationRef.current = null
      setValue(nextValue)
      setStatus('saving')
      setError(null)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        save(revisionRef.current, valueRef.current)
      }, 350)
    },
    [save],
  )

  const retry = useCallback(() => {
    if (failedOperationRef.current === 'read') {
      void load()
      return
    }
    if (failedOperationRef.current === 'write') {
      save(revisionRef.current, valueRef.current, true)
    }
  }, [load, save])

  return {
    value,
    status,
    error,
    readFailed: failedOperationRef.current === 'read',
    update,
    flush,
    retry,
  }
}
