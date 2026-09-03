import type { Model, Provider, WireApi, WireApiKind } from './types.ts';

/**
 * Holds the built-in and user-configured providers plus their models.
 * Adding a provider means registering one object here - no other file changes.
 */
export class ProviderRegistry {
  #providers = new Map<string, Provider>();
  #wires = new Map<WireApiKind, WireApi>();

  register(provider: Provider): this {
    if (this.#providers.has(provider.id)) {
      throw new Error(`provider "${provider.id}" is already registered`);
    }
    this.#providers.set(provider.id, provider);
    return this;
  }

  registerWire(wire: WireApi): this {
    this.#wires.set(wire.kind, wire);
    return this;
  }

  get(id: string): Provider | undefined {
    return this.#providers.get(id);
  }

  list(): Provider[] {
    return [...this.#providers.values()];
  }

  models(): Model[] {
    return this.list().flatMap((p) => p.models());
  }

  /** Resolve "provider/model" or a bare model id (first match wins). */
  resolveModel(ref: string): { provider: Provider; model: Model } | undefined {
    const slash = ref.indexOf('/');
    if (slash > 0) {
      const provider = this.#providers.get(ref.slice(0, slash));
      const modelId = ref.slice(slash + 1);
      const model = provider?.models().find((m) => m.id === modelId);
      if (provider && model) return { provider, model };
    }
    for (const provider of this.#providers.values()) {
      const model = provider.models().find((m) => m.id === ref);
      if (model) return { provider, model };
    }
    return undefined;
  }

  wireFor(provider: Provider, model: Model): WireApi {
    const kind = typeof provider.api === 'function' ? provider.api(model) : provider.api;
    const wire = this.#wires.get(kind);
    if (!wire) throw new Error(`no wire adapter registered for "${kind}"`);
    return wire;
  }
}
