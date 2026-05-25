import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'

const sendMock = vi.fn()
let wsOptions: { onMessage?: (msg: { type: string; sessionId: string; data: Record<string, unknown> }) => void } | null = null

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: (options: typeof wsOptions) => {
    wsOptions = options
    return {
      status: 'connected',
      sessionId: 'sess-1',
      send: sendMock,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
  },
}))

vi.mock('../components/Header', () => ({
  Header: ({ projectSelector }: { projectSelector?: ReactNode }) => (
    <div>
      <div>Header</div>
      {projectSelector}
    </div>
  ),
}))

vi.mock('../components/Sidebar', () => ({
  Sidebar: () => <div>Sidebar</div>,
}))

vi.mock('../components/ChatTimeline', () => ({
  ChatTimeline: () => <div>ChatTimeline</div>,
}))

vi.mock('../components/TimelineView', () => ({
  TimelineView: () => <div>TimelineView</div>,
}))

vi.mock('../components/WorkflowManager', () => ({
  WorkflowManager: () => null,
}))

vi.mock('../components/ProviderSettings', () => ({
  ProviderSettings: () => null,
}))

vi.mock('../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('../components/ProjectSelector', () => ({
  ProjectSelector: ({ onNewProject }: { onNewProject?: () => void }) => (
    <button onClick={onNewProject}>New Project</button>
  ),
}))

vi.mock('../components/NewProjectInline', () => ({
  NewProjectInline: ({ onReady, onCancel }: { onReady: (config: { templateId: string; style: string; duration: number }) => void; onCancel: () => void }) => (
    <div>
      <button onClick={() => onReady({ templateId: 'narrative', style: 'cinematic_realism', duration: 60 })}>
        Complete Wizard
      </button>
      <button onClick={onCancel}>Cancel Wizard</button>
    </div>
  ),
}))

vi.mock('../components/TaskInput', () => ({
  TaskInput: ({ onSend, placeholder }: { onSend: (value: string, attachments?: Array<Record<string, unknown>>) => void; placeholder?: string }) => (
    <div>
      <div>{placeholder ?? 'default-placeholder'}</div>
      <button onClick={() => onSend('project description')}>Submit Task</button>
      <button onClick={() => onSend('project description', [{
        name: 'alice.png',
        path: '/tmp/dhee/uploads/alice.png',
        url: '/api/v1/uploads/alice.png',
        mimeType: 'image/png',
        size: 123,
      }])}>
        Submit Task With Attachment
      </button>
    </div>
  ),
}))

describe('App project flow', () => {
  beforeEach(() => {
    sendMock.mockReset()
    wsOptions = null
  })

  it('starts the new project only after the ready status selects it', async () => {
    render(<App />)

    await userEvent.click(screen.getByText('New Project'))
    await userEvent.click(screen.getByText('Complete Wizard'))
    await userEvent.click(screen.getByText('Submit Task'))

    expect(sendMock).toHaveBeenCalledWith({
      type: 'create_project',
      data: expect.objectContaining({
        templateId: 'narrative',
        style: 'cinematic_realism',
        duration: 60,
        content: 'project description',
      }),
    })
    expect(sendMock).not.toHaveBeenCalledWith({
      type: 'start_task',
      data: expect.anything(),
    })

    act(() => {
      wsOptions?.onMessage?.({
        type: 'status',
        sessionId: 'sess-1',
        data: {
          status: 'ready',
          projectName: 'new-story',
        },
      })
    })

    await waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith({
        type: 'start_task',
        data: {
          task: 'Start working on this project. The project has just been created with the user content.',
        },
      })
    })
  })

  it('cancels an active run before opening the new project flow', async () => {
    render(<App />)

    act(() => {
      wsOptions?.onMessage?.({
        type: 'status',
        sessionId: 'sess-1',
        data: {
          status: 'busy',
        },
      })
    })

    await userEvent.click(screen.getByText('New Project'))

    expect(sendMock).toHaveBeenCalledWith({ type: 'cancel' })
    expect(screen.queryByText('Complete Wizard')).not.toBeInTheDocument()

    act(() => {
      wsOptions?.onMessage?.({
        type: 'status',
        sessionId: 'sess-1',
        data: {
          status: 'ready',
          message: 'Task cancelled',
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Complete Wizard')).toBeInTheDocument()
    })
  })

  it('sends staged character reference image metadata when creating a project', async () => {
    render(<App />)

    await userEvent.click(screen.getByText('New Project'))
    await userEvent.click(screen.getByText('Complete Wizard'))
    await userEvent.click(screen.getByText('Submit Task With Attachment'))

    expect(sendMock).toHaveBeenCalledWith({
      type: 'create_project',
      data: expect.objectContaining({
        content: 'project description',
        characterReferenceImages: [{
          name: 'alice.png',
          path: '/tmp/dhee/uploads/alice.png',
          url: '/api/v1/uploads/alice.png',
          mimeType: 'image/png',
          size: 123,
        }],
      }),
    })
  })
})
