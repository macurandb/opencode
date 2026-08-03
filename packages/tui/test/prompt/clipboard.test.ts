import { afterAll, expect, mock, test } from "bun:test"
import { TextareaRenderable, type HostClipboardService } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/util/global"
import { Effect, FileSystem } from "effect"
import { createComponent } from "solid-js"
import { Prompt } from "../../src/component/prompt"
import { createEventStream, createFetch } from "../fixture/tui-client"

const openTui = { ...(await import("@opentui/core")) }
let activeSetup: Awaited<ReturnType<typeof createTestRenderer>> | undefined
let reads = 0

await mock.module("@opentui/core", () => ({
  ...openTui,
  createCliRenderer: async () => {
    if (!activeSetup) throw new Error("Prompt renderer is not mounted")
    return activeSetup.renderer
  },
  createHostClipboard: () =>
    ({
      maxWriteBytes: 8 * 1024 * 1024,
      async read() {
        reads++
        return { status: "empty" }
      },
      async writeText() {
        return { status: "written" }
      },
      async clear() {
        return { status: "cleared" }
      },
      async dispose() {},
    }) satisfies HostClipboardService,
}))
await mock.module("../../src/routes/home", () => ({
  Home: () => createComponent(Prompt, { showPlaceholder: false }),
}))
const { run } = await import("../../src/app")

afterAll(() => mock.restore())

test("only zero-byte terminal pastes read the host clipboard", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  activeSetup = setup
  reads = 0
  const mounted = Promise.withResolvers<void>()
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "OpenCode") mounted.resolve()
    setTitle(title)
  }
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const preloaded = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const response = await calls.fetch(request)
      if (new URL(request.url).pathname === "/api/session/active") preloaded.resolve()
      return response
    },
  })
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ prompt: { paste: "full" as const } }), update: async () => ({}) },
      packages: { resolve: async () => undefined },
      args: {},
      log: () => {},
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
  )

  try {
    await mounted.promise
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await preloaded.promise
    await Bun.sleep(0)
    const input = setup.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Prompt textarea is not focused")

    await setup.mockInput.pasteBracketedText(" \t\n")
    await setup.waitFor(() => input.plainText === " \t\n")
    expect(reads).toBe(0)

    setup.renderer.keyInput.processPaste(new Uint8Array())
    await setup.waitFor(() => reads === 1)
    expect(input.plainText).toBe(" \t\n")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
    activeSetup = undefined
  }
})
