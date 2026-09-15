import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tauri from '../../lib/tauri'
import { useAgentMaestroCredential } from '../useAgentMaestroCredential'

vi.mock('../../lib/tauri', () => ({
  readCredential: vi.fn(),
  setCredential: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

describe('useAgentMaestroCredential', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.mocked(tauri.readCredential).mockResolvedValue(null)
    vi.mocked(tauri.setCredential).mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('distinguishes a missing credential from a failed vault read without exposing details', async () => {
    const missing = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(missing.result.current).toMatchObject({ value: '', status: 'ready', error: null })
    missing.unmount()

    vi.mocked(tauri.readCredential).mockRejectedValueOnce(
      new Error('vault exploded around secret-value'),
    )
    const failed = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(failed.result.current.status).toBe('error')
    expect(failed.result.current.error).toBeTruthy()
    expect(failed.result.current.error).not.toContain('vault exploded')
    expect(failed.result.current.error).not.toContain('secret-value')
    expect(tauri.readCredential).toHaveBeenLastCalledWith('llm', 'agent-maestro')
  })

  it('loads an existing Agent Maestro credential from the fixed vault account', async () => {
    vi.mocked(tauri.readCredential).mockResolvedValueOnce('stored-key')
    const { result } = renderHook(() => useAgentMaestroCredential('legacy-key', vi.fn()))

    await settle()

    expect(result.current.status).toBe('ready')
    expect(result.current.value).toBe('stored-key')
    expect(tauri.setCredential).not.toHaveBeenCalled()
  })

  it('persists an empty value so clearing the key deletes the vault entry', async () => {
    vi.mocked(tauri.readCredential).mockResolvedValueOnce('stored-key')
    const { result } = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    await settle()
    expect(result.current.status).toBe('ready')

    act(() => result.current.update(''))
    expect(result.current.status).toBe('saving')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'agent-maestro', '')
    expect(result.current.status).toBe('ready')
  })

  it('serializes writes so the last desired value wins', async () => {
    const firstWrite = deferred<void>()
    const secondWrite = deferred<void>()
    vi.mocked(tauri.setCredential)
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise)
    const { result } = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    await settle()
    expect(result.current.status).toBe('ready')

    act(() => {
      result.current.update('first')
      result.current.flush()
      result.current.update('second')
      result.current.flush()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(tauri.setCredential).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstWrite.resolve()
      await firstWrite.promise
    })
    expect(tauri.setCredential).toHaveBeenNthCalledWith(2, 'llm', 'agent-maestro', 'second')

    await act(async () => {
      secondWrite.resolve()
      await secondWrite.promise
    })
    expect(result.current).toMatchObject({ value: 'second', status: 'ready', error: null })
  })

  it('does not overwrite a user edit when the initial read resolves late', async () => {
    const read = deferred<string | null>()
    vi.mocked(tauri.readCredential).mockReturnValueOnce(read.promise)
    const { result } = renderHook(() => useAgentMaestroCredential('', vi.fn()))

    act(() => result.current.update('typed-key'))
    await act(async () => {
      read.resolve('old-key')
      await read.promise
    })

    expect(result.current.value).toBe('typed-key')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })
    expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'agent-maestro', 'typed-key')
  })

  it('migrates a legacy key and clears config only after persistence succeeds', async () => {
    const save = deferred<void>()
    const onLegacySaved = vi.fn()
    vi.mocked(tauri.setCredential).mockReturnValueOnce(save.promise)
    const { result } = renderHook(() => useAgentMaestroCredential('legacy-key', onLegacySaved))

    await settle()
    expect(tauri.setCredential).toHaveBeenCalled()
    expect(result.current.status).toBe('saving')
    expect(onLegacySaved).not.toHaveBeenCalled()

    await act(async () => {
      save.resolve()
      await save.promise
    })
    expect(onLegacySaved).toHaveBeenCalledWith('legacy-key')
    expect(result.current).toMatchObject({ value: 'legacy-key', status: 'ready' })
  })

  it('shows a generic save failure and retries the latest value', async () => {
    vi.mocked(tauri.setCredential)
      .mockRejectedValueOnce(new Error('could not save top-secret'))
      .mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    await settle()
    expect(result.current.status).toBe('ready')

    act(() => {
      result.current.update('top-secret')
      result.current.flush()
    })
    await settle()
    expect(result.current.status).toBe('error')
    expect(result.current.error).not.toContain('top-secret')
    expect(result.current.error).not.toContain('could not save')

    act(() => result.current.retry())
    await settle()
    expect(result.current.status).toBe('ready')
    expect(tauri.setCredential).toHaveBeenCalledTimes(2)
    expect(tauri.setCredential).toHaveBeenLastCalledWith('llm', 'agent-maestro', 'top-secret')
  })

  it('retries a failed read rather than writing an unknown value', async () => {
    vi.mocked(tauri.readCredential)
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce('recovered')
    const { result } = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    await settle()
    expect(result.current.status).toBe('error')

    act(() => result.current.retry())
    await settle()

    expect(result.current.status).toBe('ready')
    expect(result.current.value).toBe('recovered')
    expect(tauri.readCredential).toHaveBeenCalledTimes(2)
    expect(tauri.setCredential).not.toHaveBeenCalled()
  })

  it('flushes a pending edit on unmount and a remount reads after that shared write', async () => {
    const save = deferred<void>()
    vi.mocked(tauri.setCredential).mockReturnValueOnce(save.promise)
    const first = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    await settle()
    expect(first.result.current.status).toBe('ready')

    act(() => first.result.current.update('last-edit'))
    first.unmount()
    await settle()
    expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'agent-maestro', 'last-edit')

    vi.mocked(tauri.readCredential).mockResolvedValueOnce('last-edit')
    const second = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    expect(second.result.current.status).toBe('loading')
    expect(tauri.readCredential).toHaveBeenCalledTimes(1)

    await act(async () => {
      save.resolve()
      await save.promise
      await Promise.resolve()
    })
    await settle()
    expect(second.result.current.status).toBe('ready')
    expect(second.result.current.value).toBe('last-edit')
  })

  it('logs only a generic message when an unmounted save fails', async () => {
    const save = deferred<void>()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(tauri.setCredential).mockReturnValueOnce(save.promise)
    const { result, unmount } = renderHook(() => useAgentMaestroCredential('', vi.fn()))
    await settle()
    expect(result.current.status).toBe('ready')
    act(() => result.current.update('never-log-this'))
    unmount()

    await act(async () => {
      save.reject(new Error('raw vault failure never-log-this'))
      await save.promise.catch(() => undefined)
    })

    const output = consoleError.mock.calls.flat().join(' ')
    expect(output).toContain('failed to save Agent Maestro credential')
    expect(output).not.toContain('never-log-this')
    expect(output).not.toContain('raw vault failure')
    consoleError.mockRestore()
  })
})
