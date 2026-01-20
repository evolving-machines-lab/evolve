/**
 * Session Logger for Observability
 *
 * Logs agent events to local JSONL files and syncs to dashboard.
 *
 * Architecture:
 * - Local writes: Sequential promise queue (guarantees ordering)
 * - Dashboard sync: Demand-based batching with promise queue (guarantees ordering)
 * - All operations are non-blocking (fire-and-forget)
 */

import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import type { AgentType } from "../types";
import {
  DEFAULT_DASHBOARD_URL,
  SESSION_LOGS_DIR,
  DASHBOARD_BATCH_SIZE,
  DASHBOARD_FLUSH_INTERVAL_MS,
  DASHBOARD_MAX_RETRIES,
  DASHBOARD_RETRY_DELAY_MS,
} from "../constants";
import { createAgentParser, type AgentParser, type OutputEvent } from "../parsers";

const LOCAL_STORAGE_PATH = join(homedir(), SESSION_LOGS_DIR);

// =============================================================================
// TYPES
// =============================================================================

export interface SessionLoggerConfig {
  provider: string;
  agent: AgentType;
  /** Model name (e.g., "claude-sonnet-4-20250514", "codex-mini-latest") */
  model?: string;
  sandboxId: string;
  tagPrefix?: string;
  apiKey?: string;
  /** Observability metadata for trace grouping (generic key-value, domain-agnostic) */
  observability?: Record<string, unknown>;
}

// =============================================================================
// SESSION LOGGER
// =============================================================================

export class SessionLogger {
  // Identity
  private readonly tag: string;
  private readonly timestamp: string;
  private readonly provider: string;
  private readonly agent: AgentType;
  private readonly model?: string;
  private readonly sandboxId: string;

  // Configuration
  private readonly apiKey?: string;
  private readonly dashboardUrl: string;
  private readonly localFilePath: string;
  private readonly observability?: Record<string, unknown>;

  // Parser for dashboard events
  private readonly parser: AgentParser;

  // State
  private isClosed = false;
  private metaWritten = false;

  // Local file: sequential write queue
  private localQueue: Promise<void> = Promise.resolve();
  private dirReady = mkdir(LOCAL_STORAGE_PATH, { recursive: true }).catch(() => {});

  // Dashboard: event buffer + flush queue
  private eventBuffer: unknown[] = [];
  private dashboardQueue: Promise<void> = Promise.resolve();
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(config: SessionLoggerConfig) {
    this.validateConfig(config);

    // Initialize identity (order matches config interface)
    this.provider = config.provider;
    this.agent = config.agent;
    this.model = config.model;
    this.sandboxId = config.sandboxId;
    this.apiKey = config.apiKey;
    this.dashboardUrl = DEFAULT_DASHBOARD_URL;
    this.observability = config.observability;

    // Generate unique tag
    const prefix = config.tagPrefix || "evolve";
    this.tag = `${prefix}-${randomBytes(8).toString("hex")}`;

    // Generate timestamp
    this.timestamp = new Date().toISOString();

    // Build file path
    const sanitizedTs = this.timestamp.replace(/[:.]/g, "-");
    const filename = `${this.tag}_${this.provider}_${this.sandboxId}_${this.agent}_${sanitizedTs}.jsonl`;
    this.localFilePath = join(LOCAL_STORAGE_PATH, filename);

    // Create parser for this agent type
    this.parser = createAgentParser(config.agent);
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  getTag(): string {
    return this.tag;
  }

  getTimestamp(): string {
    return this.timestamp;
  }

  writePrompt(prompt: string): void {
    if (this.isClosed) return;
    this.write({ _prompt: { text: prompt } });
  }

  /**
   * Write event with pre-parsed events (avoids double parsing).
   * Use this when caller already has parsed events.
   */
  writeEventParsed(eventLine: string, parsedEvents: OutputEvent[] | null): void {
    if (this.isClosed) return;

    // LOCAL FILE: Write raw line
    this.writeLocalLine(eventLine);

    // DASHBOARD: Buffer pre-parsed events
    if (this.apiKey && parsedEvents) {
      for (const event of parsedEvents) {
        this.bufferForDashboard(event);
      }
    }
  }

  /**
   * Write event (parses internally for dashboard).
   * Use this when caller doesn't need parsed events.
   */
  writeEvent(eventLine: string): void {
    if (this.isClosed) return;

    // LOCAL FILE: Write raw line
    this.writeLocalLine(eventLine);

    // DASHBOARD: Parse and send structured events
    if (this.apiKey) {
      const parsedEvents = this.parser(eventLine);
      if (parsedEvents) {
        for (const event of parsedEvents) {
          this.bufferForDashboard(event);
        }
      }
    }
  }

  async flush(): Promise<void> {
    await this.localQueue;
    await this.dashboardQueue;
    if (this.apiKey && this.eventBuffer.length > 0) {
      this.flushDashboard();
      await this.dashboardQueue;
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Write session end marker
    this.write({ _sessionEnd: { timestamp: new Date().toISOString() } });

    await this.flush();
  }

  // ===========================================================================
  // INTERNAL: WRITE PIPELINE
  // ===========================================================================

  /**
   * Write raw JSONL line to local file (no parsing, preserves original format).
   */
  private writeLocalLine(eventLine: string): void {
    if (!this.metaWritten) {
      this.writeMeta();
    }

    // Ensure line ends with newline
    const line = eventLine.endsWith("\n") ? eventLine : eventLine + "\n";
    this.localQueue = this.localQueue
      .then(() => this.appendLocal(line))
      .catch(() => {});
  }

  /**
   * Buffer parsed event for dashboard sync.
   */
  private bufferForDashboard(event: OutputEvent): void {
    this.eventBuffer.push(event);
    this.scheduleFlush();
  }

  /**
   * Write raw entry to both local file and dashboard buffer.
   * Used for metadata (_meta, _prompt) that goes to both destinations as-is.
   */
  private write(entry: unknown): void {
    if (!this.metaWritten) {
      this.writeMeta();
    }

    const line = JSON.stringify(entry) + "\n";

    // Local file (queued for ordering)
    this.localQueue = this.localQueue
      .then(() => this.appendLocal(line))
      .catch(() => {});

    // Dashboard buffer (raw metadata, not parsed events)
    if (this.apiKey) {
      this.eventBuffer.push(entry);
      this.scheduleFlush();
    }
  }

  private writeMeta(): void {
    const meta = {
      _meta: {
        tag: this.tag,
        provider: this.provider,
        agent: this.agent,
        model: this.model,
        sandbox_id: this.sandboxId,
        timestamp: this.timestamp,
        // Spread observability fields (filtering out undefined)
        ...this.filterUndefined(this.observability),
      },
    };

    const line = JSON.stringify(meta) + "\n";

    this.localQueue = this.localQueue
      .then(() => this.appendLocal(line))
      .catch(() => {});

    if (this.apiKey) {
      this.eventBuffer.push(meta);
    }

    this.metaWritten = true;
  }

  // ===========================================================================
  // INTERNAL: LOCAL FILE
  // ===========================================================================

  private async appendLocal(line: string): Promise<void> {
    try {
      await this.dirReady;
      await appendFile(this.localFilePath, line, "utf-8");
    } catch (error) {
      console.debug("[SessionLogger] Local write failed:", error);
    }
  }

  // ===========================================================================
  // INTERNAL: DASHBOARD SYNC
  // ===========================================================================

  private scheduleFlush(): void {
    // Immediate flush if batch full
    if (this.eventBuffer.length >= DASHBOARD_BATCH_SIZE) {
      this.flushDashboard();
      return;
    }

    // Schedule delayed flush (demand-based)
    if (!this.flushTimer && !this.isClosed) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushDashboard();
      }, DASHBOARD_FLUSH_INTERVAL_MS);
    }
  }

  private flushDashboard(): void {
    if (!this.apiKey || this.eventBuffer.length === 0) return;

    // Take buffer atomically
    const events = this.eventBuffer.splice(0);

    // Queue send (preserves ordering across flushes)
    this.dashboardQueue = this.dashboardQueue
      .then(() => this.sendToDashboard(events))
      .catch(() => {});
  }

  private async sendToDashboard(events: unknown[]): Promise<void> {
    const body = {
      // Session identity (order matches _meta)
      tag: this.tag,
      provider: this.provider,
      agent: this.agent,
      model: this.model,
      sandboxId: this.sandboxId,
      timestamp: this.timestamp,
      // Observability context (hierarchy, grouping)
      ...this.filterUndefined(this.observability),
      // Payload
      events,
    };

    for (let attempt = 1; attempt <= DASHBOARD_MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${this.dashboardUrl}/api/sessions/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) return;

        // Retryable: rate limit, auth timeout, server error
        if (res.status === 429 || res.status === 401 || res.status >= 500) {
          if (attempt === DASHBOARD_MAX_RETRIES) {
            console.debug(`[SessionLogger] Dashboard ${res.status} after ${attempt} retries, requeueing`);
            this.requeueEvents(events);
            return;
          }
          await this.delay(DASHBOARD_RETRY_DELAY_MS * attempt);
          continue;
        }

        // Non-retryable client error - drop
        console.debug(`[SessionLogger] Dashboard ${res.status}, dropping events`);
        return;
      } catch (error) {
        if (attempt === DASHBOARD_MAX_RETRIES) {
          console.debug("[SessionLogger] Dashboard sync failed after retries, requeueing:", error);
          this.requeueEvents(events);
        } else {
          await this.delay(DASHBOARD_RETRY_DELAY_MS * attempt);
        }
      }
    }
  }

  private requeueEvents(events: unknown[]): void {
    this.eventBuffer.unshift(...events);
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private validateConfig(config: SessionLoggerConfig): void {
    if (
      config.apiKey &&
      !DEFAULT_DASHBOARD_URL.startsWith("https://") &&
      !DEFAULT_DASHBOARD_URL.includes("localhost") &&
      !DEFAULT_DASHBOARD_URL.includes("127.0.0.1")
    ) {
      throw new Error("Dashboard URL must use HTTPS when API key is provided");
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Filter out undefined values from an object */
  private filterUndefined(obj?: Record<string, unknown>): Record<string, unknown> {
    if (!obj) return {};
    return Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== undefined)
    );
  }
}
