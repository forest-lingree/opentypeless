import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tauri from '../../../lib/tauri'
import { useAppStore } from '../../../stores/appStore'
import { Onboarding } from '../index'

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    button: ({
      children,
      whileHover: _whileHover,
      whileTap: _whileTap,
      transition: _transition,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      whileHover?: unknown
      whileTap?: unknown
      transition?: unknown
    }) => <button {...props}>{children}</button>,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../WelcomeStep', () => ({ WelcomeStep: () => <div>Welcome</div> }))
vi.mock('../AccountStep', () => ({ AccountStep: () => <div>Account</div> }))
vi.mock('../ModeSelectStep', () => ({ ModeSelectStep: () => <div>Mode</div> }))
vi.mock('../SttSetupStep', () => ({ SttSetupStep: () => <div>STT</div> }))
vi.mock('../PermissionsStep', () => ({ PermissionsStep: () => <div>Permissions</div> }))
vi.mock('../QuickTestStep', () => ({ QuickTestStep: () => <div>Quick Test</div> }))
vi.mock('../DoneStep', () => ({ DoneStep: () => <div>Done</div> }))

vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'test-user' } }),
}))

vi.mock('../../../lib/tauri', () => ({
  updateConfig: vi.fn().mockResolvedValue(undefined),
  saveOnboardingCompleted: vi.fn().mockResolvedValue(undefined),
  readCredential: vi.fn(),
  setCredential: vi.fn(),
  fetchLlmModels: vi.fn(),
  testLlmConnection: vi.fn(),
}))

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState())
  useAppStore.setState({ onboardingStep: 5, onboardingMode: 'cloud' })
  vi.clearAllMocks()
  vi.mocked(tauri.readCredential).mockResolvedValue(null)
  vi.mocked(tauri.setCredential).mockResolvedValue(undefined)
  vi.mocked(tauri.fetchLlmModels).mockResolvedValue([])
  vi.mocked(tauri.testLlmConnection).mockResolvedValue(true)
})

afterEach(() => cleanup())

describe('Onboarding cloud navigation', () => {
  it('returns from Permissions to Mode Select because cloud skips provider setup', async () => {
    render(<Onboarding />)

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.layout.back' }))

    await waitFor(() => expect(useAppStore.getState().onboardingStep).toBe(2))
  })

  it('returns from Quick Test to Permissions', async () => {
    useAppStore.setState({ onboardingStep: 6 })
    render(<Onboarding />)

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.layout.back' }))

    await waitFor(() => expect(useAppStore.getState().onboardingStep).toBe(5))
  })

  it('requires a successful real Agent Maestro probe and invalidates it after config edits', async () => {
    useAppStore.setState({ onboardingStep: 4, onboardingMode: 'byok' })
    useAppStore.getState().updateConfig({
      llm_provider: 'agent-maestro',
      llm_api_key: '',
      llm_base_url: 'http://127.0.0.1:23333/api/openai/v1',
      llm_model: '',
    })
    vi.mocked(tauri.fetchLlmModels).mockResolvedValue(['copilot-fast', 'copilot-balanced'])

    render(<Onboarding />)

    const nextButton = screen.getByRole('button', { name: 'onboarding.layout.next' })
    expect(nextButton).toBeDisabled()

    const modelInput = screen.getByLabelText('settings.model')
    await waitFor(() =>
      expect(tauri.fetchLlmModels).toHaveBeenCalledWith(
        '',
        'agent-maestro',
        'http://127.0.0.1:23333/api/openai/v1',
      ),
    )
    expect(modelInput).toHaveValue('')
    expect(nextButton).toBeDisabled()

    fireEvent.change(modelInput, { target: { value: 'copilot-fast' } })
    const testButton = screen.getByRole('button', { name: 'settings.test' })
    await waitFor(() => expect(testButton).toBeEnabled())
    fireEvent.click(testButton)

    await waitFor(() =>
      expect(tauri.testLlmConnection).toHaveBeenCalledWith(
        '',
        'agent-maestro',
        'http://127.0.0.1:23333/api/openai/v1',
        'copilot-fast',
      ),
    )
    await waitFor(() => expect(nextButton).toBeEnabled())

    fireEvent.change(modelInput, { target: { value: 'copilot-balanced' } })
    await waitFor(() => expect(nextButton).toBeDisabled())
    expect(useAppStore.getState().llmTestStatus).toBe('idle')
  })
})
