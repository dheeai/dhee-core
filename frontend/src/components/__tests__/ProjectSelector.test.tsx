import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Dispatch } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppDispatchContext, AppStateContext, initialState, type AppAction, type AppState } from '../../lib/store'
import { ProjectSelector } from '../ProjectSelector'

const mockFetch = vi.fn()
globalThis.fetch = mockFetch

const mockProjects = {
  projects: [
    {
      dirName: 'old-project.dhee',
      title: 'Old Project',
      currentPhase: 'scene_breakdown',
      templateId: 'narrative',
    },
    {
      dirName: 'next-project.dhee',
      title: 'Next Project',
      currentPhase: 'story',
      templateId: 'documentary',
    },
  ],
}

function renderSelector(
  state: AppState,
  dispatch: Dispatch<AppAction>,
  onSendWs: (msg: Record<string, unknown>) => void
) {
  return render(
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        <ProjectSelector onSendWs={onSendWs} />
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  )
}

describe('ProjectSelector', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockProjects),
        })
      }
      if (url.endsWith('/api/v1/projects/next-project')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            currentPhase: 'story',
            executorState: { nodes: {} },
          }),
        })
      }
      if (url.endsWith('/api/v1/projects/next-project/assets')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ assets: [] }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      })
    })
  })

  it('cancels the active run before switching to another project', async () => {
    const dispatch = vi.fn()
    const onSendWs = vi.fn()
    let state: AppState = {
      ...initialState,
      selectedProject: 'old-project',
      projectMode: 'existing',
      agentStatus: 'thinking',
      connectionStatus: 'connected',
    }

    const view = renderSelector(state, dispatch, onSendWs)

    await waitFor(() => {
      expect(screen.getByText('Old Project')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: /old project/i }))
    await userEvent.click(screen.getByText('Next Project'))

    expect(onSendWs).toHaveBeenCalledWith({ type: 'cancel' })
    expect(onSendWs).not.toHaveBeenCalledWith({
      type: 'select_project',
      data: { projectName: 'next-project' },
    })

    state = {
      ...state,
      agentStatus: 'idle',
    }

    view.rerender(
      <AppStateContext.Provider value={state}>
        <AppDispatchContext.Provider value={dispatch}>
          <ProjectSelector onSendWs={onSendWs} />
        </AppDispatchContext.Provider>
      </AppStateContext.Provider>
    )

    await waitFor(() => {
      expect(onSendWs).toHaveBeenCalledWith({
        type: 'select_project',
        data: { projectName: 'next-project' },
      })
    })
  })
})
