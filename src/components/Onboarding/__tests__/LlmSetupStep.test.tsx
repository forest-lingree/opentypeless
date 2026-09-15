import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmSetupStep } from '../LlmSetupStep'
import * as tauri from '../../../lib/tauri'

const mockStore = {
  config: {
    llm_provider: 'ollama',
    llm_api_key: '',
    llm_base_url: 'http://localhost:11434/v1',
    llm_model: 'llama3.2',
    llm_azure_api_version: '2024-10-21',
  },
  updateConfig: vi.fn(),
  llmTestStatus: 'idle',
  setLlmTestStatus: vi.fn(),
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'onboarding.llm.serviceLabel': 'Service',
        'onboarding.llm.apiKeyLabel': 'API key',
        'onboarding.llm.apiKeyPlaceholder': 'API key',
        'onboarding.llm.testButton': 'Test',
        'onboarding.llm.modelLabel': 'Model',
        'onboarding.llm.modelPlaceholder': 'Model',
        'onboarding.llm.fetchModelsTitle': 'Fetch models',
        'onboarding.llm.baseUrlLabel': 'Base URL',
        'providers.llm.ollama': 'Ollama',
      })[key] ?? key,
  }),
}))

vi.mock('../../../stores/appStore', () => ({
  useAppStore: (selector: any) => selector(mockStore),
}))

vi.mock('../../../lib/tauri')

beforeEach(() => {
  mockStore.config = {
    llm_provider: 'ollama',
    llm_api_key: '',
    llm_base_url: 'http://localhost:11434/v1',
    llm_model: 'llama3.2',
    llm_azure_api_version: '2024-10-21',
  }
  mockStore.updateConfig = vi.fn()
  mockStore.llmTestStatus = 'idle'
  mockStore.setLlmTestStatus = vi.fn()
  vi.clearAllMocks()
  vi.mocked(tauri.testLlmConnection).mockResolvedValue(true)
  vi.mocked(tauri.fetchLlmModels).mockResolvedValue(['llama3.2'])
  vi.mocked(tauri.readCredential).mockResolvedValue(null)
  vi.mocked(tauri.setCredential).mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('LlmSetupStep', () => {
  it('accepts a test click as soon as an asynchronously loaded Azure key enables the button', async () => {
    let resolveRead!: (key: string) => void
    mockStore.config.llm_provider = 'azure-openai'
    vi.mocked(tauri.readCredential).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
    render(<LlmSetupStep />)
    const button = screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement
    const observer = new MutationObserver(() => {
      if (!button.disabled) {
        observer.disconnect()
        fireEvent.click(button)
      }
    })
    observer.observe(button, { attributes: true, attributeFilter: ['disabled'] })
    await waitFor(() => expect(tauri.readCredential).toHaveBeenCalled())
    resolveRead('stored-azure-key')
    try {
      await waitFor(() => expect(tauri.testLlmConnection).toHaveBeenCalled())
    } finally {
      observer.disconnect()
    }
  })

  it('does not clear a stored Azure credential when blurring the untouched loading field', async () => {
    let resolveRead!: (key: string) => void
    mockStore.config.llm_provider = 'azure-openai'
    vi.mocked(tauri.readCredential).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
    render(<LlmSetupStep />)
    await waitFor(() => expect(tauri.readCredential).toHaveBeenCalled())
    fireEvent.blur(screen.getByPlaceholderText('API key'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      resolveRead('stored-azure-key')
    })
    expect(screen.getByPlaceholderText('API key')).toHaveValue('stored-azure-key')
    expect(tauri.setCredential).not.toHaveBeenCalled()
  })

  it.each(['azure-openai', 'ollama'])(
    'resets an interrupted %s onboarding test',
    async (provider) => {
      let resolveTest!: (ok: boolean) => void
      mockStore.config.llm_provider = provider
      vi.mocked(tauri.readCredential).mockResolvedValue('azure-key')
      vi.mocked(tauri.testLlmConnection).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTest = resolve
          }),
      )
      const { unmount } = render(<LlmSetupStep />)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).not.toBeDisabled())
      fireEvent.click(screen.getByRole('button', { name: 'Test' }))
      await waitFor(() => expect(tauri.testLlmConnection).toHaveBeenCalled())
      mockStore.setLlmTestStatus.mockClear()
      unmount()
      expect(mockStore.setLlmTestStatus).toHaveBeenCalledWith('idle')
      resolveTest(true)
      await Promise.resolve()
      expect(mockStore.setLlmTestStatus).not.toHaveBeenCalledWith('success')
    },
  )

  it.each(['endpoint', 'deployment', 'version', 'key'])(
    'disables Azure testing when %s is missing',
    async (missing) => {
      mockStore.config = {
        ...mockStore.config,
        llm_provider: 'azure-openai',
        llm_base_url: missing === 'endpoint' ? ' ' : 'https://chat.openai.azure.com',
        llm_model: missing === 'deployment' ? ' ' : 'chat',
        llm_azure_api_version: missing === 'version' ? ' ' : '2024-10-21',
      }
      const key = missing === 'key' ? ' ' : 'azure-key'
      vi.mocked(tauri.readCredential).mockResolvedValue(key)
      render(<LlmSetupStep />)
      await waitFor(() => expect(screen.getByPlaceholderText('API key')).toHaveValue(key))
      expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    },
  )

  it('offers Azure and does not carry legacy keys into the new provider', async () => {
    mockStore.config.llm_api_key = 'old-secret'
    const { rerender } = render(<LlmSetupStep />)
    expect(screen.getByRole('option', { name: 'providers.llm.azureOpenAi' })).toBeInTheDocument()
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'azure-openai' } })
    expect(mockStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        llm_provider: 'azure-openai',
        llm_base_url: '',
        llm_model: '',
        llm_api_key: '',
      }),
    )
    mockStore.config = {
      ...mockStore.config,
      llm_provider: 'azure-openai',
      llm_base_url: '',
      llm_model: '',
    }
    rerender(<LlmSetupStep />)
    await waitFor(() => expect(screen.getByPlaceholderText('API key')).toHaveValue(''))
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
  })

  it('uses Azure deployment fields, stored credentials and custom API version without discovery', async () => {
    mockStore.config = {
      ...mockStore.config,
      llm_provider: 'azure-openai',
      llm_base_url: 'https://chat.openai.azure.com',
      llm_model: 'chat',
      llm_azure_api_version: '2025-04-01-preview',
    }
    vi.mocked(tauri.readCredential).mockResolvedValue('azure-key')
    render(<LlmSetupStep />)
    await waitFor(() => expect(screen.getByPlaceholderText('API key')).toHaveValue('azure-key'))
    expect(screen.getByLabelText('azure.deploymentName')).toHaveValue('chat')
    expect(screen.queryByTitle('Fetch models')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() =>
      expect(tauri.testLlmConnection).toHaveBeenCalledWith(
        'azure-key',
        'azure-openai',
        'https://chat.openai.azure.com',
        'chat',
        '2025-04-01-preview',
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(tauri.fetchLlmModels).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('API key'), { target: { value: 'new-secret' } })
    fireEvent.blur(screen.getByPlaceholderText('API key'))
    await waitFor(() =>
      expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'azure-openai', 'new-secret'),
    )
    expect(mockStore.updateConfig).not.toHaveBeenCalledWith({ llm_api_key: 'new-secret' })
  })

  it('reports Azure test and credential errors verbatim', async () => {
    mockStore.config = { ...mockStore.config, llm_provider: 'azure-openai' }
    vi.mocked(tauri.readCredential).mockResolvedValue('azure-key')
    vi.mocked(tauri.testLlmConnection).mockRejectedValue(new Error('DeploymentNotFound'))
    render(<LlmSetupStep />)
    await waitFor(() => expect(screen.getByPlaceholderText('API key')).toHaveValue('azure-key'))
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByText('DeploymentNotFound')).toBeInTheDocument())
    vi.mocked(tauri.setCredential).mockRejectedValue(new Error('vault locked'))
    fireEvent.change(screen.getByPlaceholderText('API key'), { target: { value: 'new-key' } })
    fireEvent.blur(screen.getByPlaceholderText('API key'))
    await waitFor(() => expect(screen.getByText(/vault locked/)).toBeInTheDocument())
  })

  it('invalidates a saved Azure test result when loading a missing credential', async () => {
    mockStore.config.llm_provider = 'azure-openai'
    mockStore.llmTestStatus = 'success'
    render(<LlmSetupStep />)
    await waitFor(() => expect(mockStore.setLlmTestStatus).toHaveBeenCalledWith('idle'))
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
  })

  it('discards a model request started before switching to Azure', async () => {
    let resolveModels!: (models: string[]) => void
    vi.mocked(tauri.fetchLlmModels).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve
        }),
    )
    const { rerender } = render(<LlmSetupStep />)
    fireEvent.click(screen.getByTitle('Fetch models'))
    mockStore.config.llm_provider = 'azure-openai'
    rerender(<LlmSetupStep />)
    resolveModels(['not-a-deployment'])
    await waitFor(() => expect(screen.queryByTitle('Fetch models')).not.toBeInTheDocument())
    mockStore.config.llm_provider = 'ollama'
    rerender(<LlmSetupStep />)
    expect(screen.queryByRole('option', { name: 'not-a-deployment' })).not.toBeInTheDocument()
  })

  it('does not offer managed Cloud inside BYOK provider setup', () => {
    render(<LlmSetupStep />)

    const providerSelect = screen.getAllByRole('combobox')[0]
    expect(providerSelect.querySelector('option[value="cloud"]')).toBeNull()
  })

  it('moves a saved Cloud config to a valid BYOK provider instead of showing a dead selection', async () => {
    mockStore.config = {
      llm_provider: 'cloud',
      llm_api_key: '',
      llm_base_url: 'https://www.opentypeless.com/api/proxy',
      llm_model: 'default',
      llm_azure_api_version: '2024-10-21',
    }

    render(<LlmSetupStep />)

    expect(screen.getAllByRole('combobox')[0]).toHaveValue('zhipu')
    await waitFor(() => {
      expect(mockStore.updateConfig).toHaveBeenCalledWith({
        llm_provider: 'zhipu',
        llm_base_url: 'https://open.bigmodel.cn/api/paas/v4',
        llm_model: 'glm-4-flash',
      })
    })
  })

  it('allows testing Ollama without an API key', async () => {
    render(<LlmSetupStep />)

    const button = screen.getByRole('button', { name: 'Test' })
    expect(screen.queryByPlaceholderText('API key')).not.toBeInTheDocument()
    expect(button).not.toBeDisabled()
    fireEvent.click(button)

    await waitFor(() =>
      expect(tauri.testLlmConnection).toHaveBeenCalledWith(
        '',
        'ollama',
        'http://localhost:11434/v1',
        'llama3.2',
      ),
    )
  })

  it('waits for a key before fetching models from a keyed provider', () => {
    mockStore.config = {
      llm_provider: 'zhipu',
      llm_api_key: '',
      llm_base_url: 'https://open.bigmodel.cn/api/paas/v4',
      llm_model: 'glm-4-flash',
      llm_azure_api_version: '2024-10-21',
    }

    render(<LlmSetupStep />)

    expect(screen.getByTitle('Fetch models')).toBeDisabled()
  })
})
