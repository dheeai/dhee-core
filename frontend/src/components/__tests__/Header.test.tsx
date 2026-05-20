import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithState } from '../../test/helpers'
import { Header } from '../Header'

describe('Header', () => {
  const defaultProps = {
    onProviderSettings: vi.fn(),
    onWorkflows: vi.fn(),
  }

  it('renders brand name', () => {
    renderWithState(<Header {...defaultProps} />)
    expect(screen.getByText('dhee')).toBeInTheDocument()
  })

  it('shows selected project name', () => {
    renderWithState(<Header {...defaultProps} />, {
      state: { selectedProject: 'lazarus_drive' },
    })
    expect(screen.getByText('lazarus_drive')).toBeInTheDocument()
  })

  it('shows "No project selected" when none selected', () => {
    renderWithState(<Header {...defaultProps} />)
    expect(screen.getByText('No project selected')).toBeInTheDocument()
  })

  it('shows connection status dot', () => {
    const { container } = renderWithState(<Header {...defaultProps} />, {
      state: { connectionStatus: 'connected' },
    })
    const dot = container.querySelector('[title="connected"]')
    expect(dot).toBeInTheDocument()
  })

  it('shows phase when present', () => {
    renderWithState(<Header {...defaultProps} />, {
      state: { phase: 'shot_video' },
    })
    expect(screen.getByText('shot video')).toBeInTheDocument()
  })

  it('shows context usage bar', () => {
    renderWithState(<Header {...defaultProps} />, {
      state: { contextUsage: { percentage: 42, promptTokens: 4200, maxTokens: 10000 } },
    })
    expect(screen.getByText('CTX 42%')).toBeInTheDocument()
  })

  it('calls onProviderSettings when Providers button clicked', async () => {
    const onProviderSettings = vi.fn()
    renderWithState(<Header {...defaultProps} onProviderSettings={onProviderSettings} />)
    await userEvent.click(screen.getByText('Providers'))
    expect(onProviderSettings).toHaveBeenCalledOnce()
  })

  it('calls onWorkflows when Workflows button clicked', async () => {
    const onWorkflows = vi.fn()
    renderWithState(<Header {...defaultProps} onWorkflows={onWorkflows} />)
    await userEvent.click(screen.getByText('Workflows'))
    expect(onWorkflows).toHaveBeenCalledOnce()
  })

  it('shows AUTO badge when autonomous mode enabled', () => {
    renderWithState(<Header {...defaultProps} />, {
      state: { autonomousMode: true },
    })
    expect(screen.getByText('AUTO')).toBeInTheDocument()
  })

  it('shows Serial/Parallel media mode', () => {
    renderWithState(<Header {...defaultProps} />, {
      state: { parallelMedia: true },
    })
    expect(screen.getByText('⇉ Parallel')).toBeInTheDocument()
  })
})
