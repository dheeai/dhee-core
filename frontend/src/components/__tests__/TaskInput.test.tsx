import '@testing-library/jest-dom'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithState } from '../../test/helpers'
import { TaskInput } from '../TaskInput'

describe('TaskInput', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders input field and send button', () => {
    renderWithState(<TaskInput onSend={vi.fn()} />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })
    expect(screen.getByPlaceholderText('Type a task or / for commands...')).toBeInTheDocument()
    expect(screen.getByText('Send')).toBeInTheDocument()
  })

  it('disables input when disconnected', () => {
    renderWithState(<TaskInput onSend={vi.fn()} />, {
      state: { connectionStatus: 'disconnected' },
    })
    expect(screen.getByPlaceholderText('Waiting...')).toBeDisabled()
  })

  it('disables input when agent is thinking', () => {
    renderWithState(<TaskInput onSend={vi.fn()} />, {
      state: { connectionStatus: 'connected', agentStatus: 'thinking' },
    })
    expect(screen.getByPlaceholderText('Waiting...')).toBeDisabled()
  })

  it('sends task on Enter key', async () => {
    const onSend = vi.fn()
    renderWithState(<TaskInput onSend={onSend} />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })
    const input = screen.getByPlaceholderText('Type a task or / for commands...')
    await userEvent.type(input, 'Generate a video{Enter}')
    expect(onSend).toHaveBeenCalledWith('Generate a video')
  })

  it('sends task on Send button click', async () => {
    const onSend = vi.fn()
    renderWithState(<TaskInput onSend={onSend} />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })
    const input = screen.getByPlaceholderText('Type a task or / for commands...')
    await userEvent.type(input, 'Create a scene')
    await userEvent.click(screen.getByText('Send'))
    expect(onSend).toHaveBeenCalledWith('Create a scene')
  })

  it('clears input after sending', async () => {
    renderWithState(<TaskInput onSend={vi.fn()} />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })
    const input = screen.getByPlaceholderText('Type a task or / for commands...')
    await userEvent.type(input, 'Test task{Enter}')
    expect(input).toHaveValue('')
  })

  it('does not send empty input', async () => {
    const onSend = vi.fn()
    renderWithState(<TaskInput onSend={onSend} />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })
    await userEvent.click(screen.getByText('Send'))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('renders an attach button when attachments are allowed', () => {
    renderWithState(<TaskInput onSend={vi.fn()} allowAttachments />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })
    expect(screen.getByLabelText('Attach character images')).toBeInTheDocument()
  })

  it('uploads and previews a character reference image', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'alice.png',
        path: '/tmp/dhee/uploads/alice.png',
        url: '/api/v1/uploads/alice.png',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithState(<TaskInput onSend={vi.fn()} allowAttachments />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })

    const file = new File(['image'], 'alice.png', { type: 'image/png' })
    await userEvent.upload(screen.getByLabelText('Character reference image files'), file)

    await waitFor(() => {
      expect(screen.getByAltText('alice.png')).toBeInTheDocument()
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/upload?filename=alice.png',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )
  })

  it('removes an uploaded character reference image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'alice.png',
        path: '/tmp/dhee/uploads/alice.png',
        url: '/api/v1/uploads/alice.png',
      }),
    }))

    renderWithState(<TaskInput onSend={vi.fn()} allowAttachments />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })

    const file = new File(['image'], 'alice.png', { type: 'image/png' })
    await userEvent.upload(screen.getByLabelText('Character reference image files'), file)
    await waitFor(() => expect(screen.getByText('alice.png')).toBeInTheDocument())

    await userEvent.click(screen.getByLabelText('Remove alice.png'))
    expect(screen.queryByText('alice.png')).not.toBeInTheDocument()
  })

  it('disables send while a character reference image is uploading', async () => {
    let resolveUpload: (value: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { resolveUpload = resolve })))

    renderWithState(<TaskInput onSend={vi.fn()} allowAttachments />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })

    await userEvent.upload(
      screen.getByLabelText('Character reference image files'),
      new File(['image'], 'alice.png', { type: 'image/png' }),
    )
    await userEvent.type(screen.getByPlaceholderText('Type a task or / for commands...'), 'Generate a video')

    await waitFor(() => expect(screen.getByText('Send')).toBeDisabled())

    resolveUpload({
      ok: true,
      json: async () => ({
        name: 'alice.png',
        path: '/tmp/dhee/uploads/alice.png',
        url: '/api/v1/uploads/alice.png',
      }),
    })
    await waitFor(() => expect(screen.getByText('Send')).not.toBeDisabled())
  })

  it('sends uploaded character reference images with the prompt', async () => {
    const onSend = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'alice.png',
        path: '/tmp/dhee/uploads/alice.png',
        url: '/api/v1/uploads/alice.png',
      }),
    }))

    renderWithState(<TaskInput onSend={onSend} allowAttachments />, {
      state: { connectionStatus: 'connected', agentStatus: 'idle' },
    })

    await userEvent.upload(
      screen.getByLabelText('Character reference image files'),
      new File(['image'], 'alice.png', { type: 'image/png' }),
    )
    await waitFor(() => expect(screen.getByAltText('alice.png')).toBeInTheDocument())

    await userEvent.type(screen.getByPlaceholderText('Type a task or / for commands...'), 'Generate a video')
    await userEvent.click(screen.getByText('Send'))

    expect(onSend).toHaveBeenCalledWith('Generate a video', [{
      name: 'alice.png',
      path: '/tmp/dhee/uploads/alice.png',
      url: '/api/v1/uploads/alice.png',
      mimeType: 'image/png',
      size: 5,
    }])
  })
})
