/**
 * FIFO exclusion for asynchronous operations sharing a resource. Both ordinary work and
 * barriers run exclusively: a barrier waits for all earlier work, and later work cannot
 * start until the barrier itself settles. Tasks must include their entire side effect,
 * including cleanup, in the returned promise.
 *
 * There is deliberately no timeout or cancellation API. In particular, a caller timing
 * out while awaiting a task does not release the gate or cancel that task's side effects.
 * This coordinator only orders work submitted to this instance.
 */
export class SerialCoordinator {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => T | PromiseLike<T>): Promise<T> {
    const result = this.tail.then(task)
    // A failed task must not poison the queue, but the gate remains held until it settles.
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  barrier<T>(task: () => T | PromiseLike<T>): Promise<T> {
    return this.run(task)
  }
}
