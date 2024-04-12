import { signal, batch, derived, effect } from './index'
import { expect, it } from 'vitest'

describe('signal', () => {
  it('should push updates to subscribers', () => {
    const callback = vi.fn(() => undefined)

    const subject = signal(42)
    subject.subscribe(callback)

    subject.current = 2

    expect(callback.mock.calls).toEqual([[2]])
  })

  it('should not push updates to subscribers if the value has not changed', () => {
    const callback = vi.fn(() => undefined)

    const subject = signal(42)
    subject.subscribe(callback)

    subject.current = 42

    expect(callback.mock.calls).toEqual([])
  })
})

describe('derived', () => {
  it('should memoize the value', () => {
    const dependency = signal(42)

    const subject = derived(() => {
      return { value: dependency.current }
    })

    expect(subject.current).toBe(subject.current)
  })

  it('should update the memoized value', () => {
    const dependency = signal(42)

    const subject = derived(() => {
      return { value: dependency.current }
    })

    const initialValue = subject.current
    expect(initialValue).toEqual({ value: 42 })

    dependency.current = 2

    const updatedValue = subject.current
    expect(updatedValue).toEqual({ value: 2 })
  })

  it('should subscribe to dependencies', () => {
    const callback = vi.fn(() => undefined)
    const dependency = signal(42)

    const subject = derived(() => {
      return { value: dependency.current }
    })

    subject.subscribe(callback)

    dependency.current = 2

    expect(callback.mock.calls).toEqual([[{ value: 2 }]])
  })

  it('should dynamically subscribe to dependencies', () => {
    const callback = vi.fn(() => undefined)

    const dependency1 = signal(1)
    const dependency2 = signal(2)

    const nestedDependency = signal(dependency1)

    const subject = derived(() => {
      return { value: nestedDependency.current.current }
    })

    subject.subscribe(callback)

    dependency2.current = 4
    dependency1.current = 3

    nestedDependency.current = dependency2

    dependency1.current = 5
    dependency2.current = 6

    expect(callback.mock.calls).toEqual([[{ value: 3 }], [{ value: 4 }], [{ value: 6 }]])
  })

  it('should update only once', () => {
    const callback = vi.fn(() => undefined)

    const dependency1 = signal(1)
    const dependency2 = derived(() => {
      return dependency1.current * 2
    })

    const subject = derived(() => {
      return dependency1.current * dependency2.current
    })

    subject.subscribe(callback)

    dependency1.current = 2

    expect(callback.mock.calls).toEqual([[8]])
  })

  it('should memoize intermediate values', () => {
    const dependency1 = signal(1)
    const dependency2 = derived(() => {
      return dependency1.current - dependency1.current
    })

    const subject = derived(() => {
      return { value: dependency2.current }
    })

    const previousValue = subject.current

    dependency1.current = 2

    expect(subject.current).toBe(previousValue)
  })

  it('should memoize the value when the dependency value did not change in batch', () => {
    const dependency = signal(42)

    const subject = derived(() => {
      return { value: dependency.current }
    })

    const snapshot = subject.current

    batch(() => {
      dependency.current = 1
      dependency.current = 42
    })

    expect(subject.current).toBe(snapshot)
  })

  it('should throw when getting the value', () => {
    const dependency = signal(42)

    const subject = derived(() => {
      if (dependency.current !== 42) {
        throw new Error()
      }
    })

    dependency.current = 1

    expect(() => subject.current).toThrow(Error)
  })

  it('should allow dependent updates', () => {
    const dependency = signal(2)

    const subject = derived(() => {
      return dependency.current * 2
    })

    dependency.current = subject.current

    expect(dependency.current).toBe(4)
    expect(subject.current).toBe(8)
  })

  it('should invalidate uncommitted subscriptions', () => {
    const callback = vi.fn(() => undefined)

    const dependency1 = signal(true)
    const dependency2 = signal(1)
    const dependency3 = signal(2)

    const subject = derived(() => {
      if (dependency1.current) {
        return dependency2.current
      } else {
        return dependency3.current
      }
    })

    subject.subscribe(callback)

    batch(() => {
      dependency1.current = false

      // force validation
      void subject.current

      // force rollback to previous version
      dependency1.current = true
    })

    dependency2.current = 3

    expect(callback.mock.calls).toEqual([[3]])

    dependency3.current = 4

    expect(callback.mock.calls).toEqual([[3]])
  })

  it('should recover from errors', () => {
    const dependency = atom(false)
    const subject = derivedAtom(() => {
      if (dependency.current) throw new Error()
    })

    expect(() => subject.current).not.toThrow(Error)

    dependency.current = true

    expect(() => subject.current).toThrow(Error)
    expect(() => subject.current).toThrow(Error)
  })
})

describe('effect', () => {
  it('should run the effect when its dependencies change', () => {
    const callback = vi.fn((value: unknown) => void value)

    const dependency = signal(false)

    effect(() => callback(dependency.current))

    dependency.current = true
    dependency.current = true
    dependency.current = false

    expect(callback.mock.calls).toEqual([[false], [true], [false]])
  })

  it('should run the effect again when mutating its dependencies during execution', () => {
    const callback = vi.fn(() => undefined)

    const dependency = signal(false)

    effect(() => {
      if (!dependency.current) {
        dependency.current = true
      }
      callback()
    })

    expect(callback.mock.calls).toEqual([[], []])
  })

  it('should run the inner effect once per update', () => {
    const dependency1 = signal(true)
    const dependency2 = derived(() => !dependency1.current)

    // Subscribe to dependency2 which will subscribe dependency2 to dependency1.
    // Since dependency2 is now the first subscriber of dependency1, all subscribers of dependency2
    // should be called before the other subscribers of dependency1.
    dependency2.subscribe(() => {})

    const callback = vi.fn((value: unknown) => void value)

    // Verify pre-condition that subscribers of dependency2 will be called before
    // subscribers of dependency1.
    const sub1 = dependency1.subscribe(() => callback('sub1'))
    const sub2 = dependency2.subscribe(() => callback('sub2'))
    dependency1.current = false
    expect(callback.mock.calls).toEqual([['sub2'], ['sub1']])

    sub1.dispose()
    sub2.dispose()
    callback.mockReset()

    effect(() => {
      void dependency1.current
      callback('outer')

      const sub = effect(() => {
        void dependency2.current
        callback('inner')
      })

      return () => sub.dispose()
    })

    dependency1.current = true

    expect(callback.mock.calls).toEqual([['outer'], ['inner'], ['outer'], ['inner']])
  })

  it('should dispose the effect properly (1)', () => {
    const callback = vi.fn((value: unknown) => void value)

    const dependency = signal(false)

    const sub = effect(() => {
      callback(dependency.current)
      return () => sub.dispose()
    })

    dependency.current = true

    expect(callback.mock.calls).toEqual([[false]])
  })

  it('should dispose the effect properly (2)', () => {
    const callback = vi.fn((value: unknown) => void value)

    const dependency1 = signal(false)
    const dependency2 = signal(2)

    const sub = effect(() => {
      if (dependency1.current) {
        sub.dispose()
      }
      callback(dependency2.current)
    })

    dependency1.current = true
    dependency2.current = 3

    expect(callback.mock.calls).toEqual([[2], [2]])
  })

  it('should detect looping effects', () => {
    const dependency = signal(false)

    expect(() => {
      effect(() => {
        dependency.current = !dependency.current
      })
    }).toThrow()
  })

  it('should recover from errors in derived atoms (1)', () => {
    const dependency = atom(true)
    const derivedDependency = derivedAtom(() => {
      if (dependency.current) {
        throw new Error()
      } else {
        return dependency.current
      }
    })

    const callback = vi.fn((value: unknown) => void value)

    effect(() => {
      try {
        callback(derivedDependency.current)
      } catch (e) {
        // ignore
      }
    })

    dependency.current = false
    dependency.current = true
    dependency.current = false

    expect(callback.mock.calls).toEqual([[false], [false]])
  })

  it('should recover from errors in derived atoms (2)', () => {
    const dependency = atom(false)
    const derivedDependency = derivedAtom(() => {
      if (dependency.current) {
        throw new Error()
      } else {
        return dependency.current
      }
    })

    const callback = vi.fn((value: unknown) => void value)

    effect(() => {
      try {
        callback(derivedDependency.current)
      } catch (e) {
        // ignore
      }
    })

    dependency.current = true
    dependency.current = false

    expect(callback.mock.calls).toEqual([[false], [false]])
  })

  it('should recover from errors in derived atoms (3)', () => {
    const dependency = atom(true)
    const derivedDependency = derivedAtom(() => {
      if (dependency.current) {
        throw new Error()
      } else {
        return undefined
      }
    })

    const callback = vi.fn((value: unknown) => void value)

    effect(() => {
      try {
        callback(derivedDependency.current)
      } catch (e) {
        // ignore
      }
    })

    dependency.current = false

    expect(callback.mock.calls).toEqual([[undefined]])
  })
})
