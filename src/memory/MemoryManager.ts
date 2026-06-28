// src/memory/MemoryManager.ts
// Unified facade that wires all stores, engines, processors, and PromptAssembler.
import type Database from 'better-sqlite3';
import { EventStore } from './stores/EventStore';
import { ProfileStore } from './stores/ProfileStore';
import { PersonaStore } from './stores/PersonaStore';
import { ConversationStore } from './stores/ConversationStore';
import { KnowledgeStore } from './stores/KnowledgeStore';
import { WorldbookStore } from './stores/WorldbookStore';
import { CodeContextStore } from './stores/CodeContextStore';
import { WorldbookMatcher } from './engines/WorldbookMatcher';
import { PersonaAdapter } from './engines/PersonaAdapter';
import { ProfileExtractor } from './engines/ProfileExtractor';
import { RealtimeProcessor } from './processors/RealtimeProcessor';
import { SessionEndProcessor } from './processors/SessionEndProcessor';
import { CronProcessor } from './processors/CronProcessor';
import { PromptAssembler } from './PromptAssembler';
import { filterPII } from './PIIFilter';
import type { MemoryEvent, MemoryReadRequest, MemoryReadResult, SearchResult } from './types';
import type { IVectorStore } from './interfaces/IVectorStore';
import type { IEmbedService } from './interfaces/IEmbedService';
import type { ILLMService } from './interfaces/ILLMService';

export class MemoryManager {
  private eventStore: EventStore;
  private profileStore: ProfileStore;
  private personaStore: PersonaStore;
  private conversationStore: ConversationStore;
  private knowledgeStore: KnowledgeStore;
  private worldbookStore: WorldbookStore;
  private codeContextStore: CodeContextStore;
  private worldbookMatcher: WorldbookMatcher;
  private personaAdapter: PersonaAdapter;
  private profileExtractor: ProfileExtractor;
  private promptAssembler: PromptAssembler;
  private realtimeProcessor: RealtimeProcessor;
  private sessionEndProcessor: SessionEndProcessor;
  private cronProcessor: CronProcessor;

  constructor(
    private db: Database.Database,
    private vectorStore: IVectorStore | null,
    private embedService: IEmbedService,
    private llmService: ILLMService,
  ) {
    this.eventStore = new EventStore(db);
    this.profileStore = new ProfileStore(db);
    this.personaStore = new PersonaStore(db);
    this.conversationStore = new ConversationStore(db, vectorStore);
    this.knowledgeStore = new KnowledgeStore(db, vectorStore);
    this.worldbookStore = new WorldbookStore(db);
    this.codeContextStore = new CodeContextStore(db);

    this.worldbookMatcher = new WorldbookMatcher(this.worldbookStore);
    this.personaAdapter = new PersonaAdapter(this.personaStore, llmService);
    this.profileExtractor = new ProfileExtractor(llmService);
    this.promptAssembler = new PromptAssembler(
      this.profileStore, this.personaStore, this.conversationStore,
      this.knowledgeStore, this.worldbookStore, this.codeContextStore,
    );

    this.realtimeProcessor = new RealtimeProcessor(
      this.eventStore, this.worldbookMatcher, this.personaAdapter,
      this.profileStore, this.embedService, this.vectorStore,
    );
    this.sessionEndProcessor = new SessionEndProcessor(
      this.eventStore, this.conversationStore, this.profileStore,
      this.personaStore, this.worldbookStore, this.profileExtractor,
      this.personaAdapter, this.llmService, this.embedService, this.vectorStore,
    );
    this.cronProcessor = new CronProcessor(
      this.eventStore, this.conversationStore, this.knowledgeStore,
      this.profileStore, this.profileExtractor, this.llmService, this.vectorStore,
    );
  }

  async ingest(event: MemoryEvent): Promise<void> {
    // PII filter before storing
    if (event.payload.content) {
      event.payload = { ...event.payload, content: filterPII(event.payload.content as string) };
    }

    // Write to event log (immutable)
    this.eventStore.insert(event);

    // Fire realtime processing (async, don't await)
    this.realtimeProcessor.process(event).catch(err => {
      console.error('Realtime processing error:', err);
    });
  }

  async read(req: MemoryReadRequest): Promise<MemoryReadResult> {
    // Worldbook matching
    const triggers = await this.worldbookMatcher.match(req.query, req.mode);

    // Vector search
    let retrieved: SearchResult[] = [];
    try {
      const vector = await this.embedService.embed(req.query);
      const [convResults, knowledgeResults] = await Promise.all([
        this.conversationStore.searchByVector(vector, req.limit),
        this.knowledgeStore.searchByVector(vector, Math.min(3, req.limit)),
      ]);
      retrieved = [...convResults, ...knowledgeResults]
        .sort((a, b) => b.score - a.score)
        .slice(0, req.limit);
    } catch {
      // Fallback: SQLite LIKE search when embed API fails
      retrieved = [
        ...this.conversationStore.searchByText(req.query, req.limit),
        ...this.knowledgeStore.searchByText(req.query, Math.min(3, req.limit)),
      ].sort((a, b) => b.score - a.score).slice(0, req.limit);
    }

    return {
      context: '',
      persona_hint: '',
      retrieved,
      worldbook_triggers: triggers,
    };
  }

  async assemble(mode: 'chat' | 'code'): Promise<string> {
    return this.promptAssembler.assemble(mode);
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    await this.sessionEndProcessor.process(sessionId);
  }

  async cron(): Promise<void> {
    await this.cronProcessor.process();
  }
}
