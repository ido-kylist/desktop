import type { GenerationEvent } from "@shared/ipc-contract";

/**
 * The in-process fan-out for generation events.
 *
 * Not Node's `EventEmitter`: that would hand every listener untyped varargs, make
 * "which generation was this for" the listener's problem, and leave removal as a
 * second, easily forgotten call. The only thing anyone actually does here is watch
 * one generation until it terminates, so that is the whole API.
 *
 * Delivery is synchronous and unordered across listeners, which matches how the
 * events are produced: `seq` is what orders them, and every listener sees the same
 * sequence.
 */

export type GenerationListener = (event: GenerationEvent) => void;

export class GenerationBus {
  private readonly listeners = new Map<string, Set<GenerationListener>>();

  /** Returns the unsubscribe. Safe to call more than once. */
  subscribe(generationId: string, listener: GenerationListener): () => void {
    const set = this.listeners.get(generationId) ?? new Set<GenerationListener>();
    set.add(listener);
    this.listeners.set(generationId, set);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(generationId);
    };
  }

  emit(event: GenerationEvent): void {
    const set = this.listeners.get(event.generationId);
    if (set === undefined) return;
    // Copied, so a listener that unsubscribes while handling an event does not
    // change the set being iterated.
    for (const listener of [...set]) listener(event);
  }

  /** Observers still attached. Used to prove the service releases them. */
  listenerCount(generationId: string): number {
    return this.listeners.get(generationId)?.size ?? 0;
  }
}
