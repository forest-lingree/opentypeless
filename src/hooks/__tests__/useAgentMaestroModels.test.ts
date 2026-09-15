import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tauri from '../../lib/tauri'
import { useAgentMaestroModels } from '../useAgentMaestroModels'

vi.mock('../../lib/tauri', () => ({
  fetchLlmModels: vi.fn(),
}))

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useAgentMaestroModels', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('does not fetch while disabled or when the URL is blank', async () => {
    const { result, rerender } = renderHook(
      ({ baseUrl, apiKey, enabled }) => useAgentMaestroModels(baseUrl, apiKey, enabled),
      {
        initialProps: {
          baseUrl: '',
          apiKey: 'secret',
          enabled: true,
        },
      },
    )

    expect(result.current).toMatchObject({
      models: [],
      status: 'idle',
      error: null,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })
    expect(tauri.fetchLlmModels).not.toHaveBeenCalled()

    rerender({
      baseUrl: ' http://127.0.0.1:23333/api/openai/v1 ',
      apiKey: 'secret',
      enabled: false,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })
    expect(tauri.fetchLlmModels).not.toHaveBeenCalled()
  })

  it('debounces automatic fetches, trims the URL, and does not auto-retry after failure', async () => {
    vi.mocked(tauri.fetchLlmModels).mockRejectedValueOnce(
      new Error('request failed for key secret-key'),
    )

    const { result } = renderHook(() =>
      useAgentMaestroModels('  http://127.0.0.1:23333/api/openai/v1  ', 'secret-key', true),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(tauri.fetchLlmModels).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await flushMicrotasks()

    expect(tauri.fetchLlmModels).toHaveBeenCalledTimes(1)
    expect(tauri.fetchLlmModels).toHaveBeenCalledWith(
      'secret-key',
      'agent-maestro',
      'http://127.0.0.1:23333/api/openai/v1',
    )
    expect(result.current.status).toBe('error')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(tauri.fetchLlmModels).toHaveBeenCalledTimes(1)
  })

  it('marks an empty discovery result as success', async () => {
    vi.mocked(tauri.fetchLlmModels).mockResolvedValueOnce([])

    const { result } = renderHook(() =>
      useAgentMaestroModels('http://127.0.0.1:23333/api/openai/v1', '', true),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await flushMicrotasks()

    expect(result.current).toMatchObject({
      models: [],
      status: 'success',
      error: null,
    })
  })

  it('hides stale suggestions immediately and keeps only the newest URL response', async () => {
    const firstRequest = createDeferred<string[]>()
    const secondRequest = createDeferred<string[]>()
    vi.mocked(tauri.fetchLlmModels)
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    const { result, rerender } = renderHook(
      ({ baseUrl }) => useAgentMaestroModels(baseUrl, '', true),
      {
        initialProps: {
          baseUrl: 'http://127.0.0.1:23333/api/openai/v1',
        },
      },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(result.current.status).toBe('loading')

    await act(async () => {
      firstRequest.resolve(['first-model'])
      await firstRequest.promise
    })
    expect(result.current.models).toEqual(['first-model'])
    expect(result.current.status).toBe('success')

    rerender({
      baseUrl: 'http://127.0.0.1:24444/api/openai/v1',
    })

    expect(result.current).toMatchObject({
      models: [],
      status: 'idle',
      error: null,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(result.current.status).toBe('loading')

    await act(async () => {
      secondRequest.resolve(['second-model'])
      await secondRequest.promise
    })

    expect(result.current.models).toEqual(['second-model'])
    expect(result.current.status).toBe('success')
  })

  it('ignores stale errors from an earlier URL request', async () => {
    const firstRequest = createDeferred<string[]>()
    const secondRequest = createDeferred<string[]>()
    vi.mocked(tauri.fetchLlmModels)
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    const { result, rerender } = renderHook(
      ({ baseUrl }) => useAgentMaestroModels(baseUrl, '', true),
      {
        initialProps: {
          baseUrl: 'http://127.0.0.1:23333/api/openai/v1',
        },
      },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    rerender({
      baseUrl: 'http://127.0.0.1:24444/api/openai/v1',
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    await act(async () => {
      secondRequest.resolve(['newest-model'])
      await secondRequest.promise
    })
    expect(result.current.models).toEqual(['newest-model'])
    expect(result.current.status).toBe('success')

    await act(async () => {
      firstRequest.reject(new Error('late failure'))
      await firstRequest.promise.catch(() => undefined)
    })

    expect(result.current.models).toEqual(['newest-model'])
    expect(result.current.status).toBe('success')
    expect(result.current.error).toBeNull()
  })

  it('treats rapid API key changes as a new scope and ignores old responses', async () => {
    const firstRequest = createDeferred<string[]>()
    const secondRequest = createDeferred<string[]>()
    vi.mocked(tauri.fetchLlmModels)
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    const { result, rerender } = renderHook(
      ({ apiKey }) =>
        useAgentMaestroModels('http://127.0.0.1:23333/api/openai/v1', apiKey, true),
      {
        initialProps: {
          apiKey: 'key-one',
        },
      },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    rerender({ apiKey: 'key-two' })
    expect(result.current).toMatchObject({
      models: [],
      status: 'idle',
      error: null,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(tauri.fetchLlmModels).toHaveBeenNthCalledWith(
      2,
      'key-two',
      'agent-maestro',
      'http://127.0.0.1:23333/api/openai/v1',
    )

    await act(async () => {
      secondRequest.resolve(['key-two-model'])
      await secondRequest.promise
    })
    expect(result.current.models).toEqual(['key-two-model'])

    await act(async () => {
      firstRequest.resolve(['key-one-model'])
      await firstRequest.promise
    })
    expect(result.current.models).toEqual(['key-two-model'])
  })

  it('keeps previous suggestions on same-scope refresh failure and redacts the key', async () => {
    const refreshRequest = createDeferred<string[]>()
    vi.mocked(tauri.fetchLlmModels)
      .mockResolvedValueOnce(['cached-model'])
      .mockReturnValueOnce(refreshRequest.promise)

    const { result } = renderHook(() =>
      useAgentMaestroModels('http://127.0.0.1:23333/api/openai/v1', 'secret-key', true),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await flushMicrotasks()

    expect(result.current.models).toEqual(['cached-model'])
    expect(result.current.status).toBe('success')

    await act(async () => {
      void result.current.refresh()
    })
    expect(result.current.models).toEqual(['cached-model'])
    expect(result.current.status).toBe('loading')

    const longError = `failure for secret-key ${'x'.repeat(400)}`
    await act(async () => {
      refreshRequest.reject(new Error(longError))
      await refreshRequest.promise.catch(() => undefined)
    })

    expect(result.current.models).toEqual(['cached-model'])
    expect(result.current.status).toBe('error')
    expect(result.current.error).not.toContain('secret-key')
    expect(result.current.error).toContain('[REDACTED]')
    expect(result.current.error?.length).toBeLessThanOrEqual(300)
  })

  it('keeps loading state until the newest explicit refresh finishes', async () => {
    const firstRefresh = createDeferred<string[]>()
    const secondRefresh = createDeferred<string[]>()
    vi.mocked(tauri.fetchLlmModels)
      .mockResolvedValueOnce(['cached-model'])
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise)

    const { result } = renderHook(() =>
      useAgentMaestroModels('http://127.0.0.1:23333/api/openai/v1', '', true),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await flushMicrotasks()

    await act(async () => {
      void result.current.refresh()
      void result.current.refresh()
    })
    expect(result.current.status).toBe('loading')
    expect(result.current.models).toEqual(['cached-model'])

    await act(async () => {
      firstRefresh.resolve(['stale-model'])
      await firstRefresh.promise
    })

    expect(result.current.status).toBe('loading')
    expect(result.current.models).toEqual(['cached-model'])

    await act(async () => {
      secondRefresh.resolve(['fresh-model'])
      await secondRefresh.promise
    })

    expect(result.current.status).toBe('success')
    expect(result.current.models).toEqual(['fresh-model'])
  })

  it('ignores late responses after unmount', async () => {
    const request = createDeferred<string[]>()
    vi.mocked(tauri.fetchLlmModels).mockReturnValueOnce(request.promise)

    const { unmount } = renderHook(() =>
      useAgentMaestroModels('http://127.0.0.1:23333/api/openai/v1', '', true),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    unmount()

    await act(async () => {
      request.resolve(['ignored-model'])
      await request.promise
    })

    expect(tauri.fetchLlmModels).toHaveBeenCalledTimes(1)
  })
})
