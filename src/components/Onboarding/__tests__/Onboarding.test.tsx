import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Onboarding } from '../index'

const mockStore = {
  onboardingStep: 5,
  setOnboardingStep: vi.fn(),
  setOnboardingCompleted: vi.fn(),
  sttTestStatus: 'idle',
  llmTestStatus: 'idle',
  onboardingMode: 'cloud',
  setOnboardingMode: vi.fn(),
  updateConfig: vi.fn(),
  config: {},
}

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../OnboardingLayout', () => ({
  OnboardingLayout: ({
    children,
    onBack,
    canNext,
  }: {
    children: React.ReactNode
    onBack: () => void
    canNext: boolean
  }) => (
    <div>
      <button disabled={!canNext}>Next</button>
      <button type="button" onClick={onBack}>
        Back
      </button>
      {children}
    </div>
  ),
}))

vi.mock('../WelcomeStep', () => ({ WelcomeStep: () => <div>Welcome</div> }))
vi.mock('../AccountStep', () => ({ AccountStep: () => <div>Account</div> }))
vi.mock('../ModeSelectStep', () => ({ ModeSelectStep: () => <div>Mode</div> }))
vi.mock('../SttSetupStep', () => ({ SttSetupStep: () => <div>STT</div> }))
vi.mock('../LlmSetupStep', () => ({ LlmSetupStep: () => <div>LLM</div> }))
vi.mock('../PermissionsStep', () => ({ PermissionsStep: () => <div>Permissions</div> }))
vi.mock('../QuickTestStep', () => ({ QuickTestStep: () => <div>Quick Test</div> }))
vi.mock('../DoneStep', () => ({ DoneStep: () => <div>Done</div> }))

vi.mock('../../../stores/appStore', () => ({
  useAppStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}))

vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'test-user' } }),
}))

vi.mock('../../../lib/tauri', () => ({
  updateConfig: vi.fn().mockResolvedValue(undefined),
  saveOnboardingCompleted: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
  mockStore.onboardingStep = 5
  mockStore.onboardingMode = 'cloud'
  mockStore.setOnboardingStep.mockReset()
})

afterEach(() => cleanup())

describe('Onboarding cloud navigation', () => {
  it.each([3, 4])(
    'blocks incomplete Azure configuration despite stale success at step %s',
    (step) => {
      mockStore.onboardingStep = step
      mockStore.sttTestStatus = 'success'
      mockStore.llmTestStatus = 'success'
      mockStore.config = {
        stt_provider: 'azure-openai',
        llm_provider: 'azure-openai',
        stt_azure_endpoint: '',
        stt_azure_deployment: '',
        stt_azure_api_version: '',
        llm_base_url: '',
        llm_model: '',
        llm_azure_api_version: '',
      }
      const { rerender } = render(<Onboarding />)
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
      mockStore.config = {
        ...mockStore.config,
        stt_azure_endpoint: 'https://speech.openai.azure.com',
        stt_azure_deployment: 'speech',
        stt_azure_api_version: '2024-10-21',
        llm_base_url: 'https://chat.openai.azure.com',
        llm_model: 'chat',
        llm_azure_api_version: '2024-10-21',
      }
      rerender(<Onboarding />)
      expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
    },
  )

  it('returns from Permissions to Mode Select because cloud skips provider setup', async () => {
    render(<Onboarding />)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    await waitFor(() => expect(mockStore.setOnboardingStep).toHaveBeenCalledWith(2))
  })

  it('returns from Quick Test to Permissions', async () => {
    mockStore.onboardingStep = 6
    render(<Onboarding />)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    await waitFor(() => expect(mockStore.setOnboardingStep).toHaveBeenCalledWith(5))
  })
})
