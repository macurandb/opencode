import { Database } from "bun:sqlite"
import { chromium, type CDPSession, type Page } from "@playwright/test"
import path from "node:path"
import { startChromeTrace } from "./chrome-trace"

const root = path.resolve(import.meta.dir, "../../../..")
const desktop = path.join(root, "packages/desktop")
const databasePath = process.env.OPENCODE_PROFILE_DB ?? "C:/Users/Lukem/.local/share/opencode/opencode.db"
const output = process.env.OPENCODE_PROFILE_OUTPUT ?? "C:/tmp/opencode/markdown-profile-results"
const cdpPort = process.env.OPENCODE_PROFILE_CDP_PORT ?? String(19_000 + (process.pid % 1_000))
const endpoint = process.env.OPENCODE_PROFILE_CDP ?? `http://127.0.0.1:${cdpPort}`
const diagnostics = process.env.OPENCODE_PROFILE_DIAGNOSTICS !== "0"
const profileCPU = process.env.OPENCODE_PROFILE_CPU === "1"
const windowEnd = Number(process.env.OPENCODE_PROFILE_WINDOW_END ?? Date.now())
const windowStart = windowEnd - 24 * 60 * 60 * 1_000

type Target = {
  label: "p50" | "p95" | "max"
  id: string
  directory: string
  title: string
  bytes: number
  messages: number
  parts: number
  userTurns: number
}

type ProbeResult = {
  longTasks: number[]
  animationFrames: {
    duration: number
    blockingDuration: number
    forcedStyleAndLayoutDuration: number
    scripts: {
      function: string
      source: string
      position: number
      invoker: string
      invokerType: string
      duration: number
      forcedStyleAndLayoutDuration: number
    }[]
  }[]
  frameGaps: number[]
  responseText: { url: string; duration: number }[]
}

const targets = loadTargets()
const typingText = loadTypingText(targets.find((target) => target.label === "max")!)
await Bun.$`mkdir -p ${output}`
process.env.OPENCODE_PERFORMANCE_TRACE_DIR = path.join(output, "traces")
process.env.OPENCODE_PERFORMANCE_RUN_ID = new Date(windowEnd).toISOString().replace(/[:.]/g, "-")

if (process.env.OPENCODE_PROFILE_SKIP_BUILD !== "1") await run(["bun", "run", "build"], desktop)

const child = Bun.spawn(["bun", "run", "preview"], {
  cwd: desktop,
  env: {
    ...process.env,
    OPENCODE_DB: databasePath,
    OPENCODE_CHANNEL: "dev",
    OPENCODE_PROFILE_LOAF: "1",
    OPENCODE_PROFILE_CDP_PORT: cdpPort,
    OPENCODE_PROFILE_USER_DATA:
      process.env.OPENCODE_PROFILE_USER_DATA ?? "C:/tmp/opencode/markdown-profile-user-data",
  },
  stdout: "pipe",
  stderr: "pipe",
})
const stdout = drain(child.stdout)
const stderr = drain(child.stderr)
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined

try {
  await waitForCDP()
  browser = await chromium.connectOverCDP(endpoint)
  const page = await waitForRenderer(browser)
  await page.waitForFunction(() => typeof window.api === "object", undefined, { timeout: 60_000 })
  await installProbe(page)
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}")
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ ...settings, general: { ...settings.general, newLayoutDesigns: true } }),
    )
  })

  const results = []
  results.push(await profileHome(page))
  results.push(await profileCalibration(page))
  for (const target of targets) {
    results.push(await profileSession(page, target))
  }
  results.push(await profileComposer(page))
  results.push(await profileHistoryBoundary(page, targets.find((target) => target.label === "max")!))
  const review = await profileReview(page)
  if (review) results.push(review)

  const report = {
    schemaVersion: 1,
    source: "real-opencode-db",
    diagnostics,
    profileCPU,
    window: {
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
    },
    revision: (await Bun.$`git rev-parse HEAD`.cwd(root).text()).trim(),
    targets: targets.map(({ id: _, directory: __, title: ___, ...target }) => target),
    results,
  }
  const file = path.join(output, "renderer-profile.json")
  await Bun.write(file, JSON.stringify(report, null, 2))
  console.log(`PROFILE_REPORT ${file}`)
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close().catch(() => {})
  await killTree(child.pid)
  await Promise.allSettled([stdout, stderr])
}

async function profileCalibration(page: Page) {
  await resetProbe(page)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(function opencodeProfileCalibration() {
          const end = performance.now() + 80
          while (performance.now() < end) {
            // Deliberate benchmark-only main-thread block.
          }
          requestAnimationFrame(() => setTimeout(resolve, 100))
        })
      }),
  )
  const metrics = await collectProbe(page)
  return { name: "attribution-calibration", ...summarizeProbe(metrics) }
}

function loadTargets() {
  const database = new Database(databasePath, { readonly: true })
  database.run("PRAGMA query_only = ON")
  const sessions = database
    .query(
      `SELECT id, directory, title
       FROM session AS candidate
       WHERE parent_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM message
           WHERE session_id = candidate.id AND time_created >= ? AND time_created < ?
         )`,
    )
    .all(windowStart, windowEnd) as { id: string; directory: string; title: string }[]
  const messageRows = database.query(
    `SELECT id, data
     FROM message
     WHERE session_id = ? AND time_created >= ? AND time_created < ?
     ORDER BY time_created, id`,
  )
  const partRows = database.query(`SELECT data FROM part WHERE message_id = ? ORDER BY id`)
  const ranked = sessions
    .map((session) => {
      const messages = messageRows.all(session.id, windowStart, windowEnd) as { id: string; data: string }[]
      const parts = messages.flatMap((message) => partRows.all(message.id) as { data: string }[])
      return {
        ...session,
        bytes:
          messages.reduce((sum, message) => sum + Buffer.byteLength(message.data), 0) +
          parts.reduce((sum, part) => sum + Buffer.byteLength(part.data), 0),
        messages: messages.length,
        parts: parts.length,
        userTurns: messages.filter((message) => JSON.parse(message.data).role === "user").length,
      }
    })
    .filter((session) => session.messages > 0)
    .sort((a, b) => a.bytes - b.bytes || a.id.localeCompare(b.id))
  database.close()
  if (ranked.length === 0) throw new Error("No sessions found in the profile window")
  const select = (label: Target["label"], percentile: number) => ({
    label,
    ...ranked[Math.max(0, Math.ceil(ranked.length * percentile) - 1)]!,
  })
  return [select("p50", 0.5), select("p95", 0.95), select("max", 1)] satisfies Target[]
}

function loadTypingText(target: Target) {
  const database = new Database(databasePath, { readonly: true })
  database.run("PRAGMA query_only = ON")
  const messages = database
    .query(
      `SELECT id, data
       FROM message
       WHERE session_id = ? AND time_created >= ? AND time_created < ?
       ORDER BY time_created, id`,
    )
    .all(target.id, windowStart, windowEnd) as { id: string; data: string }[]
  const parts = database.query(`SELECT data FROM part WHERE message_id = ? ORDER BY id`)
  const text = messages
    .filter((message) => JSON.parse(message.data).role === "user")
    .flatMap((message) =>
      (parts.all(message.id) as { data: string }[]).flatMap((part) => {
        const data = JSON.parse(part.data)
        return data.type === "text" && typeof data.text === "string" ? [data.text] : []
      }),
    )
    .sort((a, b) => b.length - a.length)[0]
  database.close()
  if (!text) throw new Error("No real user prompt found for composer profiling")
  return text
}

async function profileHome(page: Page) {
  const stopTrace = diagnostics ? await startChromeTrace(page, "home") : undefined
  const cpu = await startCPUProfile(page)
  const started = performance.now()
  await setDesktopRoute(page, "/")
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForSelector('[data-component="home-session-row"]', { timeout: 60_000 })
  await waitForQuietDOM(page)
  const elapsedMs = performance.now() - started
  const metrics = await collectProbe(page)
  const dom = await page.evaluate(() => ({
    elements: document.getElementsByTagName("*").length,
    timelineRows: document.querySelectorAll("[data-timeline-row]").length,
    messageRows: document.querySelectorAll("[data-message-id]").length,
    markdownRoots: document.querySelectorAll('[data-component="markdown"]').length,
    diffViewers: document.querySelectorAll('[data-component="file"][data-mode="diff"]').length,
  }))
  return {
    name: "home",
    elapsedMs,
    ...summarizeProbe(metrics),
    dom,
    cpu: await cpu.stop(),
    trace: await stopTrace?.(),
  }
}

async function profileSession(page: Page, target: Target) {
  await setDesktopRoute(page, "/")
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForSelector('[data-component="home-session-row"]', { timeout: 60_000 })
  await waitForQuietDOM(page)
  await resetProbe(page)
  const stopTrace = diagnostics ? await startChromeTrace(page, `session-${target.label}`) : undefined
  const cpu = await startCPUProfile(page)
  const started = performance.now()
  await page.evaluate((title) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-component="home-session-row"]')].find(
      (element) => element.textContent?.includes(title),
    )
    if (!button) throw new Error("Ranked root session was not found on Home")
    button.click()
  }, target.title)
  await page.waitForSelector('[data-component="prompt-input"]', { timeout: 60_000 })
  await waitForQuietDOM(page)
  const elapsedMs = performance.now() - started
  const metrics = await collectProbe(page)
  const dom = await page.evaluate(() => ({
    elements: document.getElementsByTagName("*").length,
    timelineRows: document.querySelectorAll("[data-timeline-row]").length,
    messageRows: document.querySelectorAll("[data-message-id]").length,
    markdownRoots: document.querySelectorAll('[data-component="markdown"]').length,
    diffViewers: document.querySelectorAll('[data-component="file"][data-mode="diff"]').length,
  }))
  return {
    name: `session-${target.label}`,
    context: {
      serializedBytes: target.bytes,
      messages: target.messages,
      parts: target.parts,
      userTurns: target.userTurns,
    },
    elapsedMs,
    ...summarizeProbe(metrics),
    dom,
    cpu: await cpu.stop(),
    trace: await stopTrace?.(),
  }
}

async function profileComposer(page: Page) {
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]').first()
  await editor.click()
  await page.keyboard.press("Control+A")
  await page.keyboard.press("Backspace")
  const printable = [...typingText].filter(
    (character) => character !== "\r" && character !== "\n" && character !== "\t",
  )
  const measured = printable.slice(-120).join("")
  const prefix = printable.slice(0, -measured.length).join("")
  if (prefix) await page.keyboard.insertText(prefix)
  await waitForQuietDOM(page)
  await resetProbe(page)
  const stopTrace = diagnostics ? await startChromeTrace(page, "composer-typing") : undefined
  const cpu = await startCPUProfile(page)
  const durations: number[] = []
  for (const character of measured) {
    const started = performance.now()
    await page.keyboard.type(character)
    durations.push(performance.now() - started)
  }
  await waitForQuietDOM(page)
  const metrics = await collectProbe(page)
  await page.keyboard.press("Control+A")
  await page.keyboard.press("Backspace")
  return {
    name: "composer-typing",
    context: { promptCharacters: printable.length, measuredCharacters: measured.length },
    typing: {
      totalMs: sum(durations),
      meanMs: sum(durations) / durations.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: Math.max(...durations),
    },
    ...summarizeProbe(metrics),
    cpu: await cpu.stop(),
    trace: await stopTrace?.(),
  }
}

async function profileHistoryBoundary(page: Page, target: Target) {
  await page.waitForSelector('[data-component="prompt-input"]', { timeout: 60_000 })
  await waitForQuietDOM(page)
  await resetProbe(page)
  const stopTrace = diagnostics ? await startChromeTrace(page, "session-max-history-boundary") : undefined
  const cpu = await startCPUProfile(page)
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") }).first()
  const started = performance.now()
  let requests = 0
  const onResponse = (response: { url(): string }) => {
    if (/\/session\/[^/]+\/message(?:\?|$)/.test(response.url())) requests++
  }
  page.on("response", onResponse)
  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -10_000, bubbles: true }))
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  const timeout = Date.now() + 60_000
  while (requests === 0 && Date.now() < timeout) await page.waitForTimeout(50)
  if (requests === 0) throw new Error("History boundary did not request a page")
  await waitForQuietDOM(page)
  page.off("response", onResponse)
  const elapsedMs = performance.now() - started
  const metrics = await collectProbe(page)
  return {
    name: "session-max-history-boundary",
    context: {
      serializedBytes: target.bytes,
      messages: target.messages,
      parts: target.parts,
      userTurns: target.userTurns,
    },
    elapsedMs,
    messageRequests: requests,
    ...summarizeProbe(metrics),
    cpu: await cpu.stop(),
    trace: await stopTrace?.(),
  }
}

async function profileReview(page: Page) {
  const button = page.getByRole("button", { name: "Toggle review" })
  if (!(await button.isVisible().catch(() => false))) return
  const panel = page.locator("#review-panel")
  if (await panel.isVisible().catch(() => false)) {
    await button.click()
    await panel.waitFor({ state: "hidden", timeout: 60_000 })
    await waitForQuietDOM(page)
  }
  await resetProbe(page)
  const stopTrace = diagnostics ? await startChromeTrace(page, "review-open") : undefined
  const cpu = await startCPUProfile(page)
  const started = performance.now()
  await button.click()
  await panel.waitFor({ state: "visible", timeout: 60_000 })
  await waitForQuietDOM(page)
  const elapsedMs = performance.now() - started
  const metrics = await collectProbe(page)
  const dom = await page.evaluate(() => ({
    elements: document.getElementsByTagName("*").length,
    diffViewers: document.querySelectorAll('[data-component="file"][data-mode="diff"]').length,
    diffLines: document.querySelectorAll("[data-line]").length,
  }))
  return {
    name: "review-open",
    elapsedMs,
    ...summarizeProbe(metrics),
    dom,
    cpu: await cpu.stop(),
    trace: await stopTrace?.(),
  }
}

async function installProbe(page: Page) {
  await page.addInitScript((attributeResponses) => {
    const state = {
      longTasks: [] as number[],
      animationFrames: [] as ProbeResult["animationFrames"],
      frameGaps: [] as number[],
      responseText: [] as ProbeResult["responseText"],
    }
    ;(window as Window & { __opencodeRendererProfile?: typeof state }).__opencodeRendererProfile = state
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      new PerformanceObserver((list) =>
        state.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
      ).observe({
        type: "longtask",
      })
    }
    if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      new PerformanceObserver((list) =>
        state.animationFrames.push(
          ...list.getEntries().map((entry) => {
            const frame = entry as PerformanceEntry & {
              blockingDuration: number
              scripts?: {
                duration: number
                forcedStyleAndLayoutDuration?: number
                sourceFunctionName?: string
                sourceURL?: string
                sourceCharPosition?: number
                invoker?: string
                invokerType?: string
              }[]
            }
            return {
              duration: frame.duration,
              blockingDuration: frame.blockingDuration,
              forcedStyleAndLayoutDuration:
                frame.scripts?.reduce((sum, script) => sum + (script.forcedStyleAndLayoutDuration ?? 0), 0) ?? 0,
              scripts:
                frame.scripts?.map((script) => ({
                  function: script.sourceFunctionName || "(anonymous)",
                  source: script.sourceURL?.split("/").at(-1) || "(document)",
                  position: script.sourceCharPosition ?? -1,
                  invoker: script.invoker ?? "(unknown)",
                  invokerType: script.invokerType ?? "(unknown)",
                  duration: script.duration,
                  forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration ?? 0,
                })) ?? [],
            }
          }),
        ),
      ).observe({ type: "long-animation-frame" })
    }
    let previous = performance.now()
    const frame = (now: number) => {
      const gap = now - previous
      if (gap > 20) state.frameGaps.push(gap)
      previous = now
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    if (attributeResponses) {
      const responseText = Response.prototype.text
      Response.prototype.text = function () {
        const started = performance.now()
        const url = this.url
        return responseText.call(this).then((text) => {
          state.responseText.push({ url, duration: performance.now() - started })
          return text
        })
      }
    }
  }, process.env.OPENCODE_PROFILE_RESPONSE_URLS === "1")
}

async function resetProbe(page: Page) {
  await page.evaluate(() => {
    const state = (window as Window & { __opencodeRendererProfile?: ProbeResult }).__opencodeRendererProfile
    if (!state) return
    state.longTasks.length = 0
    state.animationFrames.length = 0
    state.frameGaps.length = 0
    state.responseText.length = 0
  })
}

async function collectProbe(page: Page) {
  return page.evaluate(
    () => (window as Window & { __opencodeRendererProfile?: ProbeResult }).__opencodeRendererProfile!,
  )
}

function summarizeProbe(probe: ProbeResult) {
  const scripts = new Map<
    string,
    {
      function: string
      source: string
      position: number
      invoker: string
      invokerType: string
      durationMs: number
      forcedStyleAndLayoutMs: number
    }
  >()
  probe.animationFrames
    .flatMap((frame) => frame.scripts)
    .forEach((script) => {
      const key = `${script.source}:${script.position}:${script.invoker}`
      const current = scripts.get(key) ?? {
        function: script.function,
        source: script.source,
        position: script.position,
        invoker: script.invoker,
        invokerType: script.invokerType,
        durationMs: 0,
        forcedStyleAndLayoutMs: 0,
      }
      current.durationMs += script.duration
      current.forcedStyleAndLayoutMs += script.forcedStyleAndLayoutDuration
      scripts.set(key, current)
    })
  return {
    longTasks: {
      count: probe.longTasks.length,
      totalMs: sum(probe.longTasks),
      maxMs: Math.max(0, ...probe.longTasks),
    },
    longAnimationFrames: {
      count: probe.animationFrames.length,
      totalBlockingMs: sum(probe.animationFrames.map((frame) => frame.blockingDuration)),
      maxDurationMs: Math.max(0, ...probe.animationFrames.map((frame) => frame.duration)),
      forcedStyleAndLayoutMs: sum(probe.animationFrames.map((frame) => frame.forcedStyleAndLayoutDuration)),
      scripts: [...scripts.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 15),
    },
    frameGaps: {
      count: probe.frameGaps.length,
      maxMs: Math.max(0, ...probe.frameGaps),
    },
    responseText: probe.responseText
      .map((item) => ({
        path: (() => {
          try {
            return new URL(item.url).pathname
          } catch {
            return item.url
          }
        })(),
        durationMs: item.duration,
      }))
      .sort((a, b) => b.durationMs - a.durationMs),
  }
}

async function startCPUProfile(page: Page) {
  if (!profileCPU) return { stop: async () => [] }
  const session = await page.context().newCDPSession(page)
  await session.send("Profiler.enable")
  await session.send("Profiler.setSamplingInterval", { interval: 1_000 })
  await session.send("Profiler.start")
  return {
    async stop() {
      const result = await session.send("Profiler.stop")
      await session.detach()
      const self = new Map<number, number>()
      result.profile.samples?.forEach((id, index) => {
        self.set(id, (self.get(id) ?? 0) + (result.profile.timeDeltas?.[index] ?? 0) / 1_000)
      })
      return result.profile.nodes
        .map((node) => ({
          function: node.callFrame.functionName || "(anonymous)",
          source: sourceName(node.callFrame.url),
          line: node.callFrame.lineNumber + 1,
          selfMs: self.get(node.id) ?? 0,
        }))
        .filter((node) => node.selfMs >= 1)
        .sort((a, b) => b.selfMs - a.selfMs)
        .slice(0, 40)
    },
  }
}

async function setDesktopRoute(page: Page, route: string) {
  await page.evaluate(async (value) => {
    const api = window.api as typeof window.api & { getWindowID?: () => Promise<string> }
    const id = (await api.getWindowID?.()) ?? "browser"
    localStorage.setItem(`opencode.desktop.window.${id}.last-active-url`, value)
  }, route)
}

async function waitForQuietDOM(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let timer = setTimeout(done, 750)
        const observer = new MutationObserver(() => {
          clearTimeout(timer)
          timer = setTimeout(done, 750)
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        function done() {
          observer.disconnect()
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }
      }),
  )
}

async function waitForCDP() {
  const timeout = Date.now() + 5 * 60_000
  while (Date.now() < timeout) {
    const ready = await fetch(`${endpoint}/json/version`)
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) return
    if (child.exitCode !== null)
      throw new Error(
        `Desktop exited before CDP was ready (${child.exitCode})\n${await stdout}\n${await stderr}`,
      )
    await Bun.sleep(250)
  }
  throw new Error("Timed out waiting for desktop CDP")
}

async function waitForRenderer(browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>) {
  const timeout = Date.now() + 60_000
  while (Date.now() < timeout) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("oc://renderer"))
    if (page) return page
    await Bun.sleep(100)
  }
  throw new Error("Desktop renderer target was not found")
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, env: processEnv(), stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`)
}

function processEnv() {
  return { ...process.env, OPENCODE_DB: databasePath, OPENCODE_CHANNEL: "dev" }
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let output = ""
  for await (const chunk of stream) output = (output + decoder.decode(chunk, { stream: true })).slice(-50_000)
  return output + decoder.decode()
}

async function killTree(pid: number) {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM")
    return
  }
  const child = Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
  await child.exited
}

function sourceName(value: string) {
  if (!value) return "(native)"
  try {
    return new URL(value).pathname.split("/").at(-1) || "(document)"
  } catch {
    return path.basename(value)
  }
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function percentile(values: number[], quantile: number) {
  return values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0
}
