# Complete Test Suite - Given-When-Then Scenarios

## FAILING TESTS (9 tests)

### ❌ FAIL: getStateTransitionPrompt > generates PHASE START instructions when no items are approved
**GIVEN** project in characters_settings phase with no approved items
**WHEN** generating state transition prompt
**THEN** should include "PHASE START" instructions

---

### ❌ FAIL: getStateTransitionPrompt > generates RESUMING MID-PHASE instructions when some items are approved
**GIVEN** project in characters_settings phase with some approved items
**WHEN** generating state transition prompt
**THEN** should include "RESUMING MID-PHASE" instructions

---

### ❌ FAIL: getStateTransitionPrompt > includes Current Item Statuses section
**GIVEN** project with approved items in a phase
**WHEN** generating state transition prompt
**THEN** should include "Current Item Statuses" section

---

### ❌ FAIL: getStateTransitionPrompt > generates pre-filled TodoWrite call with correct statuses
**GIVEN** project with approved and pending items
**WHEN** generating state transition prompt
**THEN** should include status: "completed" for approved items, status: "in_progress" for next item, and status: "pending" for future items

---

### ❌ FAIL: getStateTransitionPrompt > identifies next item to process
**GIVEN** project in characters_settings phase with one completed character
**WHEN** generating state transition prompt
**THEN** should include "Next Item to Process" and identify "NextUp" character

---

### ❌ FAIL: getStateTransitionPrompt > works with scenes phase
**GIVEN** project in scenes phase with first scene approved
**WHEN** generating state transition prompt
**THEN** should include "RESUMING MID-PHASE" and show "1 of 3"

---

### ❌ FAIL: getStateTransitionPrompt > works with settings in characters_settings phase
**GIVEN** project in characters_settings phase with forest setting approved
**WHEN** generating state transition prompt
**THEN** should include "Current Item Statuses" section

---

### ❌ FAIL: Bug prevention > Character creation without plot context > should NOT have plot details when context_refs is empty
**GIVEN** plot stored with character details (Zephyr, 37 years old, lighthouse keeper, silver eyes)
**WHEN** agent dispatches character creation WITHOUT passing plot in context_refs
**THEN** content agent should NOT receive plot details (Zephyr, 37 years old, lighthouse keeper, silver eyes, Shadowmaw) in system prompt

---

### ❌ FAIL: Bug prevention > Character creation without plot context > should demonstrate the difference between with and without context
**GIVEN** plot stored with character details (Zephyr, 37 years old, lighthouse keeper, silver eyes, scar on left cheek)
**WHEN** dispatching character creation first without context_refs, then with context_refs
**THEN** system prompt should differ between the two calls (first call should not have plot details)

---

## PASSING TESTS (320 tests)

### ✅ PASS: projectExists > returns false when no project exists
**GIVEN** no project directory exists
**WHEN** checking if project exists
**THEN** should return false

---

### ✅ PASS: projectExists > returns true when project exists
**GIVEN** project directory with project.json exists
**WHEN** checking if project exists
**THEN** should return true

---

### ✅ PASS: createProject > creates project.json with correct structure
**GIVEN** valid project configuration
**WHEN** creating new project
**THEN** project.json should have correct structure with all required fields

---

### ✅ PASS: createProject > creates directory structure without empty plan files
**GIVEN** new project being created
**WHEN** creating directories
**THEN** should not create empty plan files

---

### ✅ PASS: loadProject > returns null when no project exists
**GIVEN** no project directory exists
**WHEN** attempting to load project
**THEN** should return null

---

### ✅ PASS: loadProject > loads existing project correctly
**GIVEN** existing project with project.json
**WHEN** loading project
**THEN** should return project object with correct data

---

### ✅ PASS: deleteProject > returns false when no project exists
**GIVEN** no project directory exists
**WHEN** attempting to delete project
**THEN** should return false

---

### ✅ PASS: deleteProject > deletes existing project and returns true
**GIVEN** existing project directory
**WHEN** deleting project
**THEN** should remove entire .dhee directory and return true

---

### ✅ PASS: writeProjectFile > creates file on first write (not at project creation)
**GIVEN** existing project
**WHEN** writing project file for first time
**THEN** should create the file

---

### ✅ PASS: writeProjectFile > overwrites existing file
**GIVEN** existing project file
**WHEN** writing to same file path
**THEN** should overwrite existing content

---

### ✅ PASS: readProjectFile > returns null for non-existent file
**GIVEN** project without specific file
**WHEN** reading non-existent file
**THEN** should return null

---

### ✅ PASS: readProjectFile > returns content for existing file
**GIVEN** project with existing file
**WHEN** reading file
**THEN** should return file content

---

### ✅ PASS: can detect existing project on startup
**GIVEN** .dhee directory exists
**WHEN** checking for existing project on startup
**THEN** should detect and allow continuation

---

### ✅ PASS: can continue existing project with its state
**GIVEN** existing project with saved state
**WHEN** loading project
**THEN** should restore all state including phases, artifacts, and files

---

### ✅ PASS: can start new project after deleting existing
**GIVEN** existing project
**WHEN** deleting project and creating new one
**THEN** should successfully create new project

---

### ✅ PASS: preserves project state across multiple sessions
**GIVEN** project modified in one session
**WHEN** reloading project in new session
**THEN** should preserve all changes and state

---

### ✅ PASS: Character file scanning > registers orphaned character files from disk
**GIVEN** character files exist on disk but not in project.json
**WHEN** scanning for orphaned files
**THEN** should register them in project characters array

---

### ✅ PASS: Character file scanning > extracts character name from heading
**GIVEN** character file with "# CharacterName" heading
**WHEN** scanning character file
**THEN** should extract CharacterName

---

### ✅ PASS: Character file scanning > does not duplicate already registered characters
**GIVEN** character already in project.json
**WHEN** scanning for orphaned files
**THEN** should not add duplicate entry

---

### ✅ PASS: Character file scanning > marks characters as approved if phase is complete
**GIVEN** characters_settings phase is completed
**WHEN** scanning orphaned character files
**THEN** should mark characters as approved

---

### ✅ PASS: Setting file scanning > registers orphaned setting files from disk
**GIVEN** setting files exist on disk but not in project.json
**WHEN** scanning for orphaned files
**THEN** should register them in project settings array

---

### ✅ PASS: Setting file scanning > extracts setting name from heading
**GIVEN** setting file with "# SettingName" heading
**WHEN** scanning setting file
**THEN** should extract SettingName

---

### ✅ PASS: Setting file scanning > marks settings as approved if phase is complete
**GIVEN** characters_settings phase is completed
**WHEN** scanning orphaned setting files
**THEN** should mark settings as approved

---

### ✅ PASS: Scene file scanning > registers orphaned scene files from disk
**GIVEN** scene files exist on disk but not in project.json
**WHEN** scanning for orphaned files
**THEN** should register them in project scenes array

---

### ✅ PASS: Scene file scanning > extracts scene title from content
**GIVEN** scene file with "# Scene: Title" or "# Title" heading
**WHEN** scanning scene file
**THEN** should extract scene title

---

### ✅ PASS: Scene file scanning > sorts scenes by number
**GIVEN** multiple scene files (scene_01.md, scene_02.md, etc.)
**WHEN** scanning scene files
**THEN** should sort them in numerical order

---

### ✅ PASS: Scene file scanning > marks scenes as approved if phase is complete
**GIVEN** scenes phase is completed
**WHEN** scanning orphaned scene files
**THEN** should mark scenes as approved

---

### ✅ PASS: Scene file scanning > ignores files that do not match scene_XX.md pattern
**GIVEN** files with "scene" in name but wrong pattern
**WHEN** scanning for scene files
**THEN** should ignore non-matching files

---

### ✅ PASS: Scene file scanning > does not duplicate already registered scenes
**GIVEN** scene already in project.json
**WHEN** scanning for orphaned files
**THEN** should not add duplicate entry

---

### ✅ PASS: Resume mid-phase > correctly identifies approved vs pending items after reload
**GIVEN** project with mixed approved/pending items
**WHEN** reloading project from disk
**THEN** should correctly identify which items are approved and which are pending

---

### ✅ PASS: buildContextVariablesSection > should list ALL stored context variables
**GIVEN** multiple context variables stored ($plot, $character, $setting)
**WHEN** building context variables section
**THEN** should list all variables with their names and labels

---

### ✅ PASS: buildContextVariablesSection > should include example with ALL variable names
**GIVEN** context variables exist
**WHEN** building context variables section
**THEN** should include example showing context_refs=["$plot", "$character"]

---

### ✅ PASS: buildContextVariablesSection > should emphasize using ALL relevant contexts
**GIVEN** context variables exist
**WHEN** building context variables section
**THEN** should include "Pass ALL relevant contexts" and "Use these when dispatching tasks"

---

### ✅ PASS: buildContextVariablesSection > should return empty string when no contexts exist
**GIVEN** no context variables stored
**WHEN** building context variables section
**THEN** should return empty string

---

### ✅ PASS: Agent context tracking > should track active context variables via getActiveContextVariables
**GIVEN** contextStore has stored plot and character contexts
**WHEN** listing stored contexts
**THEN** should return both $plot and $character with correct metadata

---

### ✅ PASS: Bug prevention > Character creation with plot context > should HAVE plot details when context_refs includes plot
**GIVEN** plot stored with character details (Zephyr, 37 years old, lighthouse keeper, silver eyes, weathered hands, Shadowmaw)
**WHEN** agent dispatches character creation WITH plot in context_refs
**THEN** content agent should receive all plot details (Zephyr, 37 years old, lighthouse keeper, silver eyes, weathered hands, Shadowmaw) in system prompt

---

### ✅ PASS: Context reminder in main agent messages > should include context variables section when contexts exist
**GIVEN** agent with active context variables
**WHEN** generating main agent messages
**THEN** should include context variables section

---

### ✅ PASS: Context Consistency Verification > should maintain character details across plot -> character workflow
**GIVEN** plot with specific character details
**WHEN** creating character from plot
**THEN** character should maintain all details from plot

---

### ✅ PASS: Context Consistency Verification > should list all contexts for reference
**GIVEN** multiple contexts stored
**WHEN** listing all contexts
**THEN** should return all contexts with their content

---

### ✅ PASS: Context Consistency Verification > should format multiple contexts with separators
**GIVEN** multiple contexts
**WHEN** formatting for display
**THEN** should separate contexts with "---"

---

### ✅ PASS: [ContentAgentBehavior - 12 tests] Content generation with context
**GIVEN** content agent with context variables
**WHEN** generating content
**THEN** should include all relevant context in system prompt

---

### ✅ PASS: [ExpandableTodoManager - 43 tests] Todo list management
**GIVEN** expandable todo manager
**WHEN** managing todo items
**THEN** should correctly handle expand/collapse, nested items, and state tracking

---

### ✅ PASS: [ContextPassing - 11 tests] Context passing between modules
**GIVEN** context stored in ContextStore
**WHEN** passing between modules
**THEN** should maintain context integrity and metadata

---

### ✅ PASS: [PlanningAgentBehavior - 9 tests] Planning agent behavior
**GIVEN** planning agent with task
**WHEN** generating plan
**THEN** should create structured plan with correct format

---

### ✅ PASS: [AgentContextFlow - 9 tests] Agent context flow
**GIVEN** agent with context variables
**WHEN** processing tasks
**THEN** should correctly inject context into system prompts

---

### ✅ PASS: [Prompt Evals - 50 tests] Prompt evaluation tests
**GIVEN** various prompt templates
**WHEN** evaluating prompt quality
**THEN** should meet criteria for structure, clarity, and completeness

---

### ✅ PASS: [Simple Narrative Scenario - 1 test] Mock LLM and GenericAgent integration
**GIVEN** mock LLM with expected responses
**WHEN** running agent with plot input
**THEN** agent should correctly dispatch tasks and verify tool calls

---

### ✅ PASS: [FixtureLoader - 3 tests] Test fixture loading
**GIVEN** fixture files in tests/fixtures/
**WHEN** loading fixtures
**THEN** should correctly load text and JSON fixtures
