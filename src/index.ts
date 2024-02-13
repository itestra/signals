export type Listener<T> = (value: T) => void

export interface ReadonlySignal<T> {
  get current(): T

  /**
   * Returns the current value of the signal, but does not track the access.
   * See {@link untracked}
   */
  peek(): T

  subscribe(listener: Listener<T>): Effect
}

export interface Signal<T> extends ReadonlySignal<T> {
  set current(value: T)

  /** Allows updating the current value of the signal using a function */
  update(mapper: (value: T) => T): T
}

export function signal<T>(): Signal<T | undefined>
export function signal<T>(value: T): Signal<T>
export function signal<T>(value?: T): Signal<T | undefined> {
  return new SignalImpl(createValueNode(value))
}

/**
 * Creates a new signal whose value depends on other signals.
 * @example
 * const name = signal("Bob")
 *
 * const greeting = derived(() => {
 *   return `Hello, ${name.current}.`
 * })
 */
export function derived<T>(derive: () => T): ReadonlySignal<T> {
  return new SignalImpl(createDerivedNode(derive))
}

export type CleanupFn = () => void
export type RunFn = () => CleanupFn | void

/**
 * Schedules a side effect which depends on one or more signals.
 * It is run immediately and whenever one of its dependencies changes.
 * @example
 * const name = signal("Bob")
 *
 * effect(() => {
 *   console.log(`Hello, ${name.current}.`)
 * })
 */
export function effect(run: RunFn): Effect {
  return new Effect(run)
}

/**
 * Batches signal updates to only trigger side effects after all updates have been performed.
 * @example
 * const name1 = signal("Bob")
 * const name2 = signal("Steve")
 *
 * effect(() => {
 *   console.log(`Hello, ${name1.current} and ${name2.current}.`)
 * });
 *
 * batch(() => {
 *   name1.current = "Joe"
 *   name2.current = "Mary"
 * })
 */
export function batch<T>(body: () => T): T {
  const batchStarted = startBatch()
  if (!batchStarted) return body()
  try {
    return body()
  } finally {
    commitBatch()
  }
}

/**
 * Opens a new scope where dependencies are not tracked.
 * This is useful to prevent an effect to re-run when any of those untracked dependencies change.
 * @example
 * const name = signal("Bob")
 * const visitorCount = signal(0)
 *
 * effect(() => {
 *   console.log(`Hello, ${name.current}.`)
 *
 *   visitorCount.current++
 *
 *   untracked(() => {
 *     if (visitorCount.current % 100 === 0) {
 *       console.log(`You're the ${visitorCount.current}th visitor.`)
 *     }
 *   })
 * });
 */
export function untracked<T>(body: () => T): T {
  if (G.executionContext.sink?.type !== NodeType.SUBSCRIBER) return body()

  const tracking = G.executionContext.sink.tracking
  G.executionContext.sink.tracking = false
  try {
    return body()
  } finally {
    G.executionContext.sink.tracking = tracking
  }
}

/** Provides some value */
interface Source<T> {
  /** Subscribed sinks which must be notified whenever the value of this source changes. */
  readonly sinks: Set<Dependency<T>>
}

/** Consumes some values */
interface Sink {
  /** Sources which this sink depends on. May or may not be subscribed to those sources. */
  readonly sources: Array<Dependency<unknown>>
  /** Keeps track of the previous execution context which needs to be restored
   * when this sink is done running. */
  readonly previousExecutionContext: ExecutionContext
  /** Keeps track when the cached values of dependencies were last validated to avoid unnecessarily
   * validating them multiple times during the same update. */
  cachesValidInUpdate: UpdateSeqNumber
  /** Keeps track when this sink was last notified to avoid unnecessarily notifying it multiple
   * times during the same batch. */
  notifiedInBatch: BatchSeqNumber
  /** Flag whether this sink is currently running, e.g. recomputing a derived value or
   * running a side effect. */
  running: boolean
}

/** Link between a source and sink node. */
interface Dependency<T> {
  source: SourceNode<T>
  sink: SinkNode
  /** Value of the source node at the time when the sink node last validated this dependency.  */
  cachedValue: T
}

const enum NodeType {
  VALUE,
  DERIVED,
  SUBSCRIBER,
}

/** Node which holds a mutable value */
interface ValueNode<T> extends Source<T> {
  readonly type: NodeType.VALUE
  value: T
}

/** Unique value to mark uninitialized caches */
const UNINITIALIZED = Symbol()

/** Node which holds a derived value */
interface DerivedNode<T> extends Source<T>, Sink {
  readonly type: NodeType.DERIVED
  /** Function to derive the value of this node from the values of some other source nodes. */
  readonly derive: () => T
  /** Cached result of the derive function. */
  cachedValue: T | typeof UNINITIALIZED
}

/** Node which notifies a subscriber whenever the values of its sources changes. */
interface SubscriberNode extends Sink {
  readonly type: NodeType.SUBSCRIBER
  /** Notifies the subscriber that one or more dependencies have changed.
   * Gets called only once at the start of a batch,
   * but may only be acted upon at the end of the batch. */
  readonly notify: () => void
  /** Flag whether dependencies should be tracked during the execution of the side effect.
   * May be toggled during the execution of the side effect. */
  tracking: boolean
  /** Flag to temporarily disable change notifications for this node. */
  paused: boolean
}

type SourceNode<T> = ValueNode<T> | DerivedNode<T>

type SinkNode = DerivedNode<unknown> | SubscriberNode

type UpdateSeqNumber = number
type BatchSeqNumber = number

interface Globals {
  readonly executionContext: ExecutionContext
  /** Incremented everytime the value of a value node changes. */
  updateSeqNumber: UpdateSeqNumber
  /** Incremented everytime a new batch is started. */
  batchSeqNumber: BatchSeqNumber
}

interface ExecutionContext {
  /** Sink node which is currently running.
   * Accesses of source nodes should be tracked as dependencies of this sink node. */
  sink: SinkNode | null
  /** Index into the sources array of the currently running sink node. */
  sourceIndex: number
}

const G: Globals = {
  updateSeqNumber: 0,
  batchSeqNumber: 0,
  executionContext: {
    sink: null,
    sourceIndex: 0,
  },
}

function createValueNode<T>(value: T): ValueNode<T> {
  return {
    type: NodeType.VALUE,
    value,
    sinks: new Set(),
  }
}

function createDerivedNode<T>(derive: () => T): DerivedNode<T> {
  return {
    type: NodeType.DERIVED,
    derive,
    cachedValue: UNINITIALIZED,
    sinks: new Set(),
    sources: [],
    cachesValidInUpdate: 0,
    notifiedInBatch: 0,
    running: false,
    previousExecutionContext: { sink: null, sourceIndex: 0 },
  }
}

function createSubscriberNode(notify: () => void): SubscriberNode {
  return {
    type: NodeType.SUBSCRIBER,
    notify,
    sources: [],
    cachesValidInUpdate: 0,
    notifiedInBatch: 0,
    running: false,
    previousExecutionContext: { sink: null, sourceIndex: 0 },
    tracking: true,
    paused: false,
  }
}

function setValue<T>(source: ValueNode<T>, value: T): void {
  if (source.value === value) return
  source.value = value
  G.updateSeqNumber++
  const batchStarted = startBatch()
  notifySubscribers(source)
  if (batchStarted) {
    commitBatch()
  }
}

function getValueUntracked<T>(source: SourceNode<T>): T {
  if (source.type === NodeType.VALUE) {
    return source.value
  }
  if (source.cachedValue === UNINITIALIZED || isStale(source)) {
    source.cachedValue = runInContext(source, source.derive)
  }
  return source.cachedValue
}

function getValueTracked<T>(source: SourceNode<T>): T {
  const value = getValueUntracked(source)

  if (G.executionContext.sink && isTracking(G.executionContext.sink)) {
    const { sink, sourceIndex } = G.executionContext

    if (sink.sources.length <= sourceIndex) {
      const dependency = { sink, source, cachedValue: value, lastChecked: G.updateSeqNumber }
      sink.sources[sourceIndex] = dependency

      if (isSubscribed(sink)) {
        subscribeSinkToSource(dependency)
      }
    } else {
      const dependency = sink.sources[sourceIndex]
      dependency.cachedValue = value

      if (dependency.source !== source && isSubscribed(sink)) {
        unsubscribeSinkFromSource(dependency)
        dependency.source = source
        subscribeSinkToSource(dependency)
      }
    }

    G.executionContext.sourceIndex++
  }

  return value
}

function isStale(sink: SinkNode): boolean {
  const stale =
    sink.cachesValidInUpdate < G.updateSeqNumber &&
    sink.sources.some(
      (dependency) => dependency.cachedValue !== getValueUntracked(dependency.source),
    )

  if (!stale) {
    sink.cachesValidInUpdate = G.updateSeqNumber
  }

  return stale
}

function isTracking(sink: SinkNode): boolean {
  return sink.type === NodeType.DERIVED || sink.tracking
}

function isSubscribed(sink: SinkNode): boolean {
  if (sink.type === NodeType.DERIVED) {
    return sink.sinks.size > 0
  } else {
    return !sink.paused
  }
}

function subscribeSinkToSource(dependency: Dependency<unknown>) {
  const source = dependency.source
  source.sinks.add(dependency)
  if (source.type === NodeType.DERIVED && source.sinks.size === 1) {
    for (const dependency of source.sources) {
      subscribeSinkToSource(dependency)
    }
  }
}

function unsubscribeSinkFromSource(dependency: Dependency<unknown>) {
  const source = dependency.source
  source.sinks.delete(dependency)
  if (source.type === NodeType.DERIVED && source.sinks.size === 0) {
    for (const dependency of source.sources) {
      unsubscribeSinkFromSource(dependency)
    }
  }
}

function notifySubscribers(source: SourceNode<unknown>) {
  for (const dependency of source.sinks) {
    if (dependency.sink.notifiedInBatch === G.batchSeqNumber) continue

    dependency.sink.notifiedInBatch = G.batchSeqNumber
    if (dependency.sink.type === NodeType.DERIVED) {
      notifySubscribers(dependency.sink)
    } else {
      dependency.sink.notify()
    }
  }
}

function startBatch(): boolean {
  if (G.batchSeqNumber > 0) return false
  G.batchSeqNumber = G.updateSeqNumber
  return true
}

function commitBatch() {
  G.batchSeqNumber = 0
  Effect.runEffects()
  ChangeNotifier.pushNotifications()
}

function enterExecutionContext(sink: SinkNode) {
  if (sink.running) {
    throw new Error('Cyclic dependency')
  }

  sink.running = true
  sink.previousExecutionContext.sink = G.executionContext.sink
  sink.previousExecutionContext.sourceIndex = G.executionContext.sourceIndex

  G.executionContext.sink = sink
  G.executionContext.sourceIndex = 0
}

function leaveExecutionContext(sink: SinkNode) {
  if (sink !== G.executionContext.sink) {
    throw new Error('Sink is currently not active')
  }

  if (isSubscribed(sink)) {
    for (let i = G.executionContext.sourceIndex; i < sink.sources.length; i++) {
      unsubscribeSinkFromSource(sink.sources[i])
    }
  }
  sink.sources.length = G.executionContext.sourceIndex

  G.executionContext.sink = sink.previousExecutionContext.sink
  G.executionContext.sourceIndex = sink.previousExecutionContext.sourceIndex

  sink.running = false
  sink.previousExecutionContext.sink = null
  sink.previousExecutionContext.sourceIndex = 0
}

function runInContext<T>(sink: SinkNode, fn: () => T): T {
  enterExecutionContext(sink)
  try {
    return fn()
  } finally {
    leaveExecutionContext(sink)
  }
}

function pauseSubscriber(subscriber: SubscriberNode) {
  subscriber.paused = true
  subscriber.sources.forEach(unsubscribeSinkFromSource)
}

function resumeSubscriber(subscriber: SubscriberNode) {
  subscriber.paused = false
  subscriber.sources.forEach(subscribeSinkToSource)
}

class SignalImpl<T> implements Signal<T> {
  get current(): T {
    return getValueTracked(this.node)
  }

  set current(value: T) {
    if (this.node.type === NodeType.DERIVED) {
      throw new Error('Cannot set value of derived signal.')
    }
    setValue(this.node, value)
  }

  constructor(private readonly node: SourceNode<T>) {}

  peek(): T {
    return getValueUntracked(this.node)
  }

  update(mapper: (value: T) => T): T {
    return (this.current = mapper(this.current))
  }

  subscribe(listener: Listener<T>): Effect {
    let firstExecution = true
    return effect(() => {
      const value = this.current
      if (firstExecution) {
        firstExecution = false
      } else {
        untracked(() => listener(value))
      }
    })
  }
}

const LOOP_LIMIT = 100

const enum EffectState {
  UNINITIALIZED,
  ACTIVE,
  DISPOSED,
}

export class Effect {
  private static running = false
  private static readonly queuedEffects: Effect[] = []

  private get disposed(): boolean {
    return this.state === EffectState.DISPOSED
  }

  private get stale(): boolean {
    return this.state === EffectState.UNINITIALIZED || (!this.disposed && isStale(this.node))
  }

  private state = EffectState.UNINITIALIZED
  private readonly node = createSubscriberNode(() => Effect.queuedEffects.push(this))
  private cleanupFn?: () => void

  constructor(private readonly runFn: RunFn) {
    Effect.queuedEffects.push(this)
    Effect.runEffects()
  }

  dispose() {
    if (this.state !== EffectState.DISPOSED) {
      this.state = EffectState.DISPOSED
      pauseSubscriber(this.node)
      this.cleanup()
    }
  }

  private run() {
    this.state = EffectState.ACTIVE
    try {
      this.cleanupFn = runInContext(this.node, this.runFn) as CleanupFn | undefined
    } catch (err) {
      this.rethrowError(err)
    }
  }

  private cleanup() {
    try {
      this.cleanupFn?.()
    } catch (err) {
      this.rethrowError(err)
    } finally {
      this.cleanupFn = undefined
    }
  }

  private rethrowError(err: unknown) {
    queueMicrotask(() => {
      // rethrow error in micro task to not cancel other queued effects
      throw err
    })
  }

  static runEffects() {
    if (this.running) return
    this.running = true

    let batchStart = 0
    for (let i = 0; batchStart < this.queuedEffects.length && i < LOOP_LIMIT; i++) {
      const batchEnd = this.queuedEffects.length

      const staleEffects = this.queuedEffects
        .slice(batchStart, batchEnd)
        .filter((effect) => !effect.disposed && effect.stale)

      // run all cleanup functions and then all run functions to support nested effects
      for (const effect of staleEffects) effect.cleanup()

      for (const effect of staleEffects) {
        // cleanup may have disposed the effect, so we need to check again
        if (!effect.disposed) {
          effect.run()
        }
      }

      batchStart = batchEnd
    }

    const loop = batchStart < this.queuedEffects.length

    this.queuedEffects.length = 0
    this.running = false

    if (loop) {
      throw new Error('Looping effects detected')
    }
  }
}

export type OnChangeFn = (version: number) => void

export class ChangeNotifier {
  private static running = false
  private static readonly queuedNotifiers: ChangeNotifier[] = []

  /** Incremented whenever a change has occurred.
   * Useful for checking whether a rerender is actually required
   * when the rendering engine does its own batching (e.g. React). */
  version = 0

  private _onChange?: OnChangeFn

  get onChange(): OnChangeFn | undefined {
    return this._onChange
  }

  set onChange(onChangeFn: OnChangeFn | undefined) {
    this._onChange = onChangeFn
    if (onChangeFn) {
      resumeSubscriber(this.node)
    } else {
      pauseSubscriber(this.node)
    }
  }

  private stale = false
  private readonly node = createSubscriberNode(() => ChangeNotifier.queuedNotifiers.push(this))

  constructor() {
    pauseSubscriber(this.node)
  }

  startTrackingDependencies() {
    this.stale = false
    enterExecutionContext(this.node)
  }

  stopTrackingDependencies() {
    leaveExecutionContext(this.node)
  }

  static pushNotifications() {
    if (this.running) return
    this.running = true

    let batchStart = 0
    for (let i = 0; batchStart < this.queuedNotifiers.length && i < LOOP_LIMIT; i++) {
      const batchEnd = this.queuedNotifiers.length

      const staleNotifiers = this.queuedNotifiers.slice(batchStart, batchEnd)

      for (const notifier of staleNotifiers) {
        const stale = isStale(notifier.node)
        if (stale !== notifier.stale) {
          notifier.stale = stale
          if (stale) {
            notifier.version++
          } else {
            notifier.version--
          }
          notifier.onChange?.(notifier.version)
        }
      }

      batchStart = batchEnd
    }

    const loop = batchStart < this.queuedNotifiers.length

    this.queuedNotifiers.length = 0
    this.running = false

    if (loop) {
      throw new Error('Looping notifiers detected')
    }
  }
}
