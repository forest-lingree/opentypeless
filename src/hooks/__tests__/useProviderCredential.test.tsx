import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProviderCredential } from '../useProviderCredential'
import { readCredential, setCredential } from '../../lib/tauri'

vi.mock('../../lib/tauri', () => ({
  readCredential: vi.fn(),
  setCredential: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const vault = new Map<string, string>()

beforeEach(() => {
  vi.resetAllMocks()
  vault.clear()
  vault.set('llm:azure-openai', 'stored-key')
  vi.mocked(readCredential).mockImplementation(
    async (namespace, provider) => vault.get(`${namespace}:${provider}`) ?? null,
  )
  vi.mocked(setCredential).mockImplementation(async (namespace, provider, value) => {
    vault.set(`${namespace}:${provider}`, value)
  })
})

afterEach(cleanup)

describe('provider credential persistence lifetime', () => {
  it('persists the final debounced edit when the form unmounts', async () => {
    const form = renderHook(() => useProviderCredential('llm', 'azure-openai'))
    await waitFor(() => expect(form.result.current.value).toBe('stored-key'))

    act(() => {
      form.result.current.setValue('last-edit')
      form.result.current.persist('last-edit')
    })
    form.unmount()

    await waitFor(() => expect(vault.get('llm:azure-openai')).toBe('last-edit'))
  })

  it('persists a blurred edit queued behind an in-flight write across remount', async () => {
    const firstSave = deferred<void>()
    vi.mocked(setCredential).mockImplementationOnce(async (namespace, provider, value) => {
      await firstSave.promise
      vault.set(`${namespace}:${provider}`, value)
    })
    const form = renderHook(() => useProviderCredential('llm', 'azure-openai'))
    await waitFor(() => expect(form.result.current.value).toBe('stored-key'))
    act(() => {
      form.result.current.setValue('earlier-key')
      form.result.current.persist('earlier-key', 0)
    })
    await waitFor(() =>
      expect(setCredential).toHaveBeenCalledWith('llm', 'azure-openai', 'earlier-key'),
    )
    act(() => {
      form.result.current.setValue('last-edit')
      form.result.current.persist('last-edit', 0)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    form.unmount()
    const reopened = renderHook(() => useProviderCredential('llm', 'azure-openai'))
    await act(async () => {
      firstSave.resolve()
    })

    await waitFor(() => expect(reopened.result.current.value).toBe('last-edit'))
    expect(vault.get('llm:azure-openai')).toBe('last-edit')
  })

  it('keeps final edits scoped to the old provider when switching provider and namespace', async () => {
    const form = renderHook(
      ({ namespace, provider }: { namespace: 'stt' | 'llm'; provider: string }) =>
        useProviderCredential(namespace, provider),
      { initialProps: { namespace: 'llm' as 'stt' | 'llm', provider: 'azure-openai' } },
    )
    await waitFor(() => expect(form.result.current.value).toBe('stored-key'))
    act(() => {
      form.result.current.setValue('llm-last-edit')
      form.result.current.persist('llm-last-edit')
    })
    form.rerender({ namespace: 'stt', provider: 'deepgram' })

    await waitFor(() => expect(vault.get('llm:azure-openai')).toBe('llm-last-edit'))
    expect(setCredential).not.toHaveBeenCalledWith('stt', 'deepgram', 'llm-last-edit')
    expect(form.result.current.value).toBe('')
  })

  it('orders queued edits before newer edits made after remounting the same scope', async () => {
    const firstSave = deferred<void>()
    vi.mocked(setCredential).mockImplementationOnce(async (namespace, provider, value) => {
      await firstSave.promise
      vault.set(`${namespace}:${provider}`, value)
    })
    const form = renderHook(() => useProviderCredential('llm', 'azure-openai'))
    await waitFor(() => expect(form.result.current.value).toBe('stored-key'))
    act(() => {
      form.result.current.setValue('earlier-key')
      form.result.current.persist('earlier-key', 0)
    })
    await waitFor(() => expect(setCredential).toHaveBeenCalled())
    act(() => {
      form.result.current.setValue('queued-key')
      form.result.current.persist('queued-key', 0)
    })
    form.unmount()
    const reopened = renderHook(() => useProviderCredential('llm', 'azure-openai'))
    act(() => {
      reopened.result.current.setValue('newest-key')
      reopened.result.current.persist('newest-key', 0)
    })
    await act(async () => {
      firstSave.resolve()
    })
    await act(async () => {
      await reopened.result.current.flush()
    })

    expect(vault.get('llm:azure-openai')).toBe('newest-key')
    expect(vi.mocked(setCredential).mock.calls.map((call) => call[2])).toEqual([
      'earlier-key',
      'queued-key',
      'newest-key',
    ])
    expect(reopened.result.current.value).toBe('newest-key')
  })

  it('never persists an untouched empty field while the initial credential read is pending', async () => {
    const initialRead = deferred<string>()
    vi.mocked(readCredential).mockReturnValueOnce(initialRead.promise)
    const form = renderHook(() => useProviderCredential('llm', 'azure-openai'))
    await waitFor(() => expect(readCredential).toHaveBeenCalled())
    act(() => {
      form.result.current.persist(form.result.current.value, 0)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await act(async () => {
      initialRead.resolve('stored-key')
    })
    await act(async () => {
      await form.result.current.flush()
    })

    expect(setCredential).not.toHaveBeenCalled()
    expect(vault.get('llm:azure-openai')).toBe('stored-key')
    expect(form.result.current.value).toBe('stored-key')
  })

  it('still persists an intentional deletion of a loaded credential', async () => {
    const form = renderHook(() => useProviderCredential('llm', 'azure-openai'))
    await waitFor(() => expect(form.result.current.value).toBe('stored-key'))
    act(() => {
      form.result.current.setValue('')
      form.result.current.persist('', 0)
    })
    await act(async () => {
      await form.result.current.flush()
    })
    expect(vault.get('llm:azure-openai')).toBe('')
    expect(setCredential).toHaveBeenCalledWith('llm', 'azure-openai', '')
  })
})
