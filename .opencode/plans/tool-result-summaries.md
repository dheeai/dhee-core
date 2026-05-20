# Tool Result Summarization Implementation Plan

## Overview

Transforms agentic loop to use tool result summaries in message history while persisting full results to disk for on-demand retrieval.

## Design Principles

1. **Message History Efficiency**: Only summaries + ref IDs in conversation history
2. **No Extra LLM Calls**: Summary comes from existing LLM response (tool call reasoning)
3. **Reference-Based Retrieval**: LLM can fetch full results when needed via ref ID
4. **Size-Aware**: Small results (<500 chars) stay inline, large results get stored
5. **Backward Compatible**: Existing tools continue working without changes

## Architecture Changes

### Phase 1: Core Infrastructure

#### 1.1 Tool Result Store (New File)

**File**: `src/core/context/ToolResultStore.ts`

**Purpose**: Persistent storage for full tool results, similar to ContextStore pattern

**Key Features**:

- Store: `store(result: string, summary: string, toolName: string)` → returns `{refId}`
- Retrieve: `get(refId: string)` → `{result, summary, toolName, metadata}`
- List: `list()` → Array of available ref IDs with metadata
- Delete: `delete(refId: string)` → cleanup
- Cleanup: `cleanup(olderThanDays)` → remove old results

**Storage Structure**:

```
.dhee/tool-results/
  ├── index.json                    # Metadata index
  ├── tool_result_001.json          # Full result + summary
  ├── tool_result_002.json
  └── ...
```

**Reference ID Format**: `$tool_result_123` (auto-incrementing counter)

**Index Format**:

```typescript
{
  "$tool_result_1": {
    refId: "$tool_result_1",
    toolName: "read_file",
    summary: "Read config file",
    createdAt: "2026-01-22T...",
    charCount: 1234
  }
}
```

---

### Phase 2: Type Updates

#### 2.1 LLM Response Extension

**File**: `src/core/llm/types.ts`

**Change**: Add `summary` to `ToolCall`

```typescript
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  summary?: string; // NEW: LLM's reasoning for this tool call
}
```

---

#### 2.2 Tool Call Result Schema

**File**: `src/core/llm/types.ts`

**New Type**: Enhanced tool result structure

```typescript
export interface ToolCallResult {
  // Original result (backward compatible)
  [key: string]: unknown;

  // New fields (optional, can coexist)
  _summary?: string; // Tool-provided summary
  _shouldStore?: boolean; // Tool opts into storage
  _storeThreshold?: number; // Custom threshold override
}

export interface StoredToolCallResult extends ToolCallResult {
  refId: string; // Reference ID for retrieval
  stored: boolean; // Whether full result was persisted
}
```

---

### Phase 3: Tool Execution Flow Changes

#### 3.1 Modify executeTool Method

**File**: `src/core/agent/GenericAgent.ts`

**Current Flow**:

```typescript
const result = await Promise.resolve(tool.handler(toolCall.arguments));
this.messages.push({
  role: 'tool',
  content: JSON.stringify(result),
  toolCallId: toolCall.id,
  name: toolCall.name,
});
```

**New Flow**:

```typescript
// 1. Execute tool
const result = await Promise.resolve(tool.handler(toolCall.arguments));
const resultStr = JSON.stringify(result);

// 2. Determine if should store (size threshold + opt-in)
const shouldStore = this.shouldStoreToolResult(resultStr, toolCall.name, result);

// 3. Store or keep inline
let messageContent: string;
let summary: string;
let refId: string | undefined;

if (shouldStore) {
  // Get summary from tool result or LLM response
  summary = this.extractSummary(result, toolCall.summary);

  // Store full result
  const stored = toolResultStore.store(resultStr, summary, toolCall.name);
  refId = stored.refId;

  // Build message with summary + ref
  messageContent = JSON.stringify({
    summary,
    refId,
    message: `Full details stored in memory. Use fetch_tool_result with ref_id="${refId}" to retrieve.`,
  });
} else {
  // Small result, keep inline
  messageContent = resultStr;
  summary = resultStr.slice(0, 200); // Short inline summary
}

// 4. Emit event with BOTH summary and full result
this.emit({
  type: 'tool_result',
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  result: result, // Full result
  summary, // Summary (new)
  refId, // Ref ID (new)
  isError: this.resultIncludesError(result),
  agentName: this.getEffectiveAgentName(),
});

// 5. Push only summary to messages (not full result)
this.messages.push({
  role: 'tool',
  content: messageContent,
  toolCallId: toolCall.id,
  name: toolCall.name,
});
```

---

### Phase 4: Storage Logic

#### 4.1 Storage Decision Logic

**File**: `src/core/agent/GenericAgent.ts`

**New Method**: `shouldStoreToolResult`

```typescript
private static readonly TOOL_STORE_THRESHOLD = 500; // chars

private shouldStoreToolResult(
  resultStr: string,
  toolName: string,
  result: unknown
): boolean {
  // 1. Check tool-provided opt-in
  const toolResult = result as { _shouldStore?: boolean };
  if (toolResult._shouldStore !== undefined) {
    return toolResult._shouldStore;
  }

  // 2. Size threshold
  if (resultStr.length > GenericAgent.TOOL_STORE_THRESHOLD) {
    return true;
  }

  // 3. Tool type defaults (certain tools always stored)
  const ALWAYS_STORE_TOOLS = new Set([
    'dispatch_agent',
    'dispatch_content_agent',
    'dispatch_image_agent',
    'dispatch_video_agent',
    'read_file',
    'read_project',
    'grep',
  ]);

  return ALWAYS_STORE_TOOLS.has(toolName);
}
```

---

#### 4.2 Summary Extraction

**File**: `src/core/agent/GenericAgent.ts`

**New Method**: `extractSummary`

```typescript
private extractSummary(
  result: unknown,
  llmSummary?: string
): string {
  // 1. Tool-provided summary takes precedence
  const toolResult = result as { _summary?: string };
  if (toolResult._summary) {
    return toolResult._summary;
  }

  // 2. LLM-provided summary (from tool call)
  if (llmSummary) {
    return llmSummary;
  }

  // 3. Generate default summary from result
  const resultStr = JSON.stringify(result);

  // Error messages
  if (resultStr.includes('error')) {
    return 'Error: ' + this.extractErrorMessage(result);
  }

  // Success with status field
  const status = (result as { status?: string })?.status;
  if (status && status !== 'error') {
    return `Completed ${status}`;
  }

  // Fallback: first N chars
  return resultStr.slice(0, 200) + (resultStr.length > 200 ? '...' : '');
}
```

---

### Phase 5: Retrieval Tool

#### 5.1 fetch_tool_result Tool

**File**: `src/core/tools/builtin/fetchToolResult.ts` (New)

**Purpose**: Allow LLM to retrieve full tool result when needed

**Schema**:

```typescript
{
  name: 'fetch_tool_result',
  description: 'Retrieve full details of a previously executed tool call. Use when summary is insufficient and you need complete information.',
  parameters: {
    type: 'object',
    properties: {
      ref_id: {
        type: 'string',
        description: 'Reference ID from tool result (e.g., "$tool_result_1")',
      }
    },
    required: ['ref_id'],
  }
}
```

**Handler**:

```typescript
async handler(args: { ref_id: string }) {
  const stored = toolResultStore.get(args.ref_id);
  if (!stored) {
    return {
      error: `Tool result not found: ${args.ref_id}`,
      suggestion: 'The reference ID may be expired or incorrect.',
    };
  }

  return {
    ref_id: args.ref_id,
    tool_name: stored.toolName,
    summary: stored.summary,
    result: JSON.parse(stored.result), // Full original result
  };
}
```

---

### Phase 6: System Prompt Updates

#### 6.1 Tool Result Memory Instructions

**File**: `prompts/system/tool-result-memory.md` (New)

**Content**:

```markdown
## Tool Result Summaries

When you execute tools, you will receive a summary of result instead of full output. This saves context space.

**What you see:**

- Summary of what the tool accomplished
- Reference ID (e.g., `$tool_result_1`) if full result was stored

**When to fetch full results:**
Use `fetch_tool_result` when:

1. Summary is insufficient for your task
2. You need detailed output (full file contents, long lists, etc.)
3. You're debugging an issue and need complete error information

**Example workflow:**
```

# Tool call returns summary

read_file(path="config.json") -> summary: "Read 20KB config file with 150 settings"

# Later, need full content

fetch_tool_result(ref_id="$tool_result_1") -> full config contents

```

**Remember**: Tool results are stored persistently. Reference IDs remain valid until explicitly cleaned up.
```

---

#### 6.2 Update System Prompts

**Files**:

- `prompts/system/base.md`
- `prompts/system/orchestrator.md`

**Add**: Include tool-result-memory.md instruction

---

### Phase 7: Event System Updates

#### 7.1 Tool Result Event Enhancement

**File**: `src/events/events.ts`

**Update**: `ToolResultEvent`

```typescript
export interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  result: unknown; // Full result (existing)
  summary?: string; // Summary (new)
  refId?: string; // Reference ID (new)
  isError: boolean;
  agentName: string;
}
```

---

### Phase 8: UI Integration

#### 8.1 Display Tool Results

**File**: UI component showing tool calls (to be identified)

**Changes**:

- Display summary prominently
- Show "View Full" button when refId exists
- Button calls `fetch_tool_result` and displays full result in modal
- Indicate when result was stored vs. inline

**Example UI**:

```
┌─────────────────────────────────────┐
│ read_file(path="config.json")    │
│ ✓ Read 20KB config file        │
│                                │
│ [View Full Result]               │
└─────────────────────────────────────┘
```

---

### Phase 9: Testing Strategy

#### 9.1 Unit Tests

**File**: `src/core/context/ToolResultStore.test.ts` (New)

**Test Cases**:

- Store and retrieve single result
- Multiple results maintain separate IDs
- Index persistence across restarts
- Delete and cleanup operations
- Counter increments correctly

---

#### 9.2 Integration Tests

**File**: `tests/tool-result-memory.test.ts` (New)

**Test Scenarios**:

- Small result stays inline (<500 chars)
- Large result gets stored (>500 chars)
- Summary extraction from tool result
- Summary extraction from LLM response
- fetch_tool_result retrieves correctly
- Message history contains summaries only
- Events contain full results

---

#### 9.3 End-to-End Test

**Scenario**: Agent reads large file, processes content, writes back

**Verify**:

1. File read stored with ref ID
2. Summary in message history
3. Agent processes with summary
4. Agent fetches full result when needed
5. Final write uses full content
6. Context stays within limits

---

### Phase 10: Rollout Plan

#### 10.1 Gradual Enablement

**Step 1**: Feature flag

```typescript
const ENABLE_TOOL_SUMMARIES = process.env.ENABLE_TOOL_SUMMARIES === 'true';
```

**Step 2**: Test with simple tools first

- read_file
- write_file
- grep

**Step 3**: Expand to complex tools

- dispatch_agent
- generate_image
- generate_video

**Step 4**: Monitor metrics

- Context usage per iteration
- Store size on disk
- Fetch frequency (how often full results needed)
- Compression frequency (should decrease)

**Step 5**: Enable by default after validation

---

## Implementation Order

1. **ToolResultStore** (Phase 1) - Foundation
2. **Type updates** (Phase 2) - Contracts
3. **executeTool changes** (Phase 3) - Core logic
4. **Storage/summary logic** (Phase 4) - Decision making
5. **fetch_tool_result tool** (Phase 5) - Retrieval
6. **System prompts** (Phase 6) - LLM guidance
7. **Event updates** (Phase 7) - Observability
8. **UI updates** (Phase 8) - User experience
9. **Tests** (Phase 9) - Validation
10. **Rollout** (Phase 10) - Safe deployment

---

## Open Questions

1. **Threshold value**: 500 chars suggested - confirm based on testing
2. **Cleanup policy**: How long to keep tool results? (Suggest: 7 days)
3. **Store location**: `.dhee/tool-results/` acceptable?
4. **Backward compatibility**: Need to handle existing agents without summary support?

---

## Success Metrics

- **Context reduction**: 30-50% smaller message histories
- **Token savings**: 20-40% fewer tokens per iteration
- **Fetch frequency**: <10% of stored results actually fetched
- **No degradation**: Task completion rate unchanged
- **Performance**: No measurable latency increase
