import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmSetupStep } from '../LlmSetupStep'
import * as tauri from '../../../lib/tauri'

vi.mock('../../AgentMaestroFields', () => ({
  AgentMaestroFields: ({ mode }: { mode: string }) => (
    <div data-testid={`agent-maestro-${mode}`}>
      <input aria-label="Agent Maestro model" />
      <button type="button">Agent Maestro test</button>
    </div>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const mockStore = {
  config: {
    llm_provider: 'ollama',
    llm_api_key: '',
    llm_base_url: 'http://localhost:11434/v1',
    llm_model: 'llama3.2',
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
        'providers.llm.agentMaestro': 'Agent Maestro',
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
  }
  mockStore.updateConfig = vi.fn()
  mockStore.llmTestStatus = 'idle'
  mockStore.setLlmTestStatus = vi.fn()
  vi.clearAllMocks()
  vi.mocked(tauri.testLlmConnection).mockResolvedValue(true)
  vi.mocked(tauri.fetchLlmModels).mockResolvedValue(['llama3.2'])
})

afterEach(cleanup)

describe('LlmSetupStep', () => {
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
    }

    render(<LlmSetupStep />)

    expect(screen.getByTitle('Fetch models')).toBeDisabled()
  })

  it('applies isolated Agent Maestro defaults without inheriting the previous key', () => {
    mockStore.config.llm_api_key = 'old-provider-secret'
    render(<LlmSetupStep />)

    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'agent-maestro' },
    })

    expect(mockStore.updateConfig).toHaveBeenCalledWith({
      llm_provider: 'agent-maestro',
      llm_api_key: '',
      llm_base_url: 'http://127.0.0.1:23333/api/openai/v1',
      llm_model: '',
    })
  })

  it('renders only the shared Agent Maestro form instead of legacy provider fields', () => {
    mockStore.config = {
      llm_provider: 'agent-maestro',
      llm_api_key: '',
      llm_base_url: 'http://127.0.0.1:23333/api/openai/v1',
      llm_model: '',
    }

    render(<LlmSetupStep />)

    expect(screen.getByTestId('agent-maestro-onboarding')).toBeInTheDocument()
    expect(screen.getAllByRole('textbox', { name: 'Agent Maestro model' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Agent Maestro test' })).toHaveLength(1)
    expect(screen.queryByPlaceholderText('API key')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Fetch models')).not.toBeInTheDocument()
    expect(tauri.fetchLlmModels).not.toHaveBeenCalled()
  })

  it('ignores a legacy probe that completes after switching to Agent Maestro', async () => {
    const pendingProbe = deferred<boolean>()
    vi.mocked(tauri.testLlmConnection).mockReturnValueOnce(pendingProbe.promise)
    render(<LlmSetupStep />)

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: 'agent-maestro' },
    })
    await act(async () => pendingProbe.resolve(true))

    expect(mockStore.setLlmTestStatus).not.toHaveBeenCalledWith('success')
  })
})
