import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'

function DemoGreeting() {
  return <h1>Hello from Solid</h1>
}

afterEach(() => {
  cleanup()
})

describe('@solidjs/testing-library demo', () => {
  it('renders a heading', () => {
    render(() => <DemoGreeting />)

    expect(screen.getByRole('heading').textContent).toBe('Hello from Solid')
  })
})
