import { AgentStore, ChatStore, type MessageStore, type TaskStore } from "@fusion/core";
import type { ProjectEngineManager } from "@fusion/engine";
import { ChatManager } from "./chat.js";
import { requireAsyncLayer } from "./require-async-layer.js";

type ChatStoreBinding = {
  store: TaskStore;
  layer: ReturnType<TaskStore["getAsyncLayer"]> | undefined;
  chatStore: ChatStore;
};

const scopedChatStoreCache = new Map<string, ChatStoreBinding>();

function cacheKeyForStore(store: TaskStore): string {
  return store.getFusionDir();
}

export function getOrCreateScopedChatStore(store: TaskStore, fallbackChatStore?: ChatStore): ChatStore {
  const key = cacheKeyForStore(store);
  const layer = store.getAsyncLayer?.();
  if (fallbackChatStore) {
    scopedChatStoreCache.set(key, { store, layer, chatStore: fallbackChatStore });
    return fallbackChatStore;
  }

  const cached = scopedChatStoreCache.get(key);
  if (cached?.store === store && cached.layer === layer) return cached.chatStore;

  /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Project-scoped chat stores require the authoritative PostgreSQL layer; missing wiring must not create SQLite state. */
  const chatStore = new ChatStore(requireAsyncLayer(store, "Scoped ChatStore"));
  scopedChatStoreCache.set(key, { store, layer, chatStore });
  return chatStore;
}

export async function resolveProjectChatContext(options: {
  projectId?: string | null;
  defaultStore: TaskStore;
  defaultChatStore?: ChatStore;
  engineManager?: ProjectEngineManager;
  requestStore?: TaskStore;
}): Promise<{ store: TaskStore; chatStore: ChatStore }> {
  const { projectId, defaultStore, defaultChatStore, engineManager, requestStore } = options;

  /*
  FNXC:TaskChatProjectContext 2026-08-19-17:25:
  A request's canonical project store is authoritative for task Chat. A secondary project can be
  reachable before its engine is live, so substituting the dashboard default store here would make
  its synthetic task session load another project's task context or report it missing.
  */
  if (requestStore) {
    const engine = projectId ? engineManager?.getEngine(projectId) : undefined;
    const engineChatStore = engine?.getTaskStore?.() === requestStore ? engine.getChatStore?.() : undefined;
    return {
      store: requestStore,
      chatStore: getOrCreateScopedChatStore(
        requestStore,
        engineChatStore ?? (requestStore === defaultStore ? defaultChatStore : undefined),
      ),
    };
  }

  if (!projectId) {
    return {
      store: defaultStore,
      chatStore: getOrCreateScopedChatStore(defaultStore, defaultChatStore),
    };
  }

  // Only use engine path when an engine is actually found for this project.
  if (engineManager) {
    const engine = engineManager.getEngine(projectId);
    if (engine) {
      try {
        const scopedStore = engine.getTaskStore?.() ?? defaultStore;
        const engineChatStore = engine.getChatStore?.();
        return {
          store: scopedStore,
          chatStore: getOrCreateScopedChatStore(scopedStore, engineChatStore),
        };
      } catch {
        // engine's store not accessible — fall through to default
      }
    }
  }

  // No engine for this project — use the default store.
  // Route handlers apply projectId filtering at the query level.
  return {
    store: defaultStore,
    chatStore: getOrCreateScopedChatStore(defaultStore, defaultChatStore),
  };
}

export async function createProjectScopedChatManager(options: {
  store: TaskStore;
  chatStore: ChatStore;
  pluginRunner?: ConstructorParameters<typeof ChatManager>[3];
  messageStore?: MessageStore;
}): Promise<ChatManager> {
  const agentStore = new AgentStore({ rootDir: options.store.getFusionDir(), asyncLayer: options.store.getAsyncLayer() ?? undefined });
  return new ChatManager(
    options.chatStore,
    options.store.getRootDir(),
    agentStore,
    options.pluginRunner,
    () => options.store.getSettings(),
    options.messageStore,
    options.store,
  );
}

export function __resetScopedChatStoreCache(): void {
  scopedChatStoreCache.clear();
}

const scopedChatManagerCache = new Map<string, ChatStoreBinding & { manager: ChatManager }>();

export function getOrCreateScopedChatManager(
  store: TaskStore,
  chatStore: ChatStore,
  pluginRunner?: ConstructorParameters<typeof ChatManager>[3],
  refreshPluginRunner = false,
  messageStore?: MessageStore,
): ChatManager {
  const key = store.getFusionDir();
  const layer = requireAsyncLayer(store, "Scoped ChatManager");
  const cached = scopedChatManagerCache.get(key);
  if (cached) {
    /*
    FNXC:ChatDatabaseLifecycle 2026-09-09-06:03:
    A project pause closes the engine's pool while dashboard requests acquire a replacement store at the same path.
    Rebind persistence together, retaining generation/cancel state and the injected CLI runner.
    Replacement backends also release stale engine plugin/message services when their new values are absent.
    */
    if (cached.store !== store || cached.layer !== layer || cached.chatStore !== chatStore) {
      cached.manager.setProjectStores(store, chatStore, new AgentStore({ rootDir: store.getFusionDir(), asyncLayer: layer }));
      cached.manager.setPluginRunner(pluginRunner);
      cached.manager.setMessageStore(messageStore);
      scopedChatManagerCache.set(key, { store, layer, chatStore, manager: cached.manager });
    }
    if (refreshPluginRunner && pluginRunner) {
      cached.manager.setPluginRunner(pluginRunner);
    }
    if (messageStore) {
      cached.manager.setMessageStore(messageStore);
    }
    return cached.manager;
  }
  // FNXC:PostgresCutover 2026-07-05-20:10: keep the backend AsyncDataLayer on
  // the chat AgentStore (merge union with main's Hermes plugin-runner refresh).
  const agentStore = new AgentStore({ rootDir: store.getFusionDir(), asyncLayer: layer });
  /*
   * FNXC:ProjectChatRuntime 2026-07-12-11:00:
   * Project/agent chat must expose the same tool schema over desktop and browser transports. The scoped manager is cached by fusion dir, so lazy engine boot must upgrade the cached MessageStore instead of leaving fn_send_message/fn_read_messages stale-missing after the first pre-engine resolution.
   */
  const manager = new ChatManager(
    chatStore,
    store.getRootDir(),
    agentStore,
    pluginRunner,
    () => store.getSettings(),
    messageStore,
    store,
  );
  scopedChatManagerCache.set(key, { store, layer, chatStore, manager });
  return manager;
}

export function __resetScopedChatManagerCache(): void {
  scopedChatManagerCache.clear();
}
