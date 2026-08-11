export * as AgentPlugin from "./agent"

import path from "path"
import { define } from "./internal"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Global } from "../global"
import { Location } from "../location"
import { PermissionV2 } from "../permission"

const TRUNCATION_GLOB = path.join(Global.Path.data, "tool-output", "*")
const BUILD_SYSTEM =
  "You are an AI coding agent. Help the user accomplish software engineering tasks by inspecting the workspace, making targeted changes, and using tools according to the configured permissions."

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files, or run bash commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`

const PROMPT_REVIEW = `You are an independent software reviewer. Inspect the supplied Goal, Task, acceptance criteria, code, and deterministic evidence without trusting the executor's self-assessment.

You are read-only. Never modify files, run shell commands, or ask another agent to make changes. Use only read, grep, and glob when more code context is required.

Return exactly one JSON object matching the schema requested in the user prompt. Do not wrap it in markdown. Every requested criterion must have one verdict. A pass requires concrete evidence; actionable failures must include concise findings with severity and file location when known.`

const PROMPT_WORK_PLANNER = `You are the read-only planner for a durable software WorkGraph.

Inspect the workspace before decomposing the supplied Goal. Produce a compact dependency DAG whose Tasks are independently executable and whose criterion assignments cover the requested outcome. Prefer explicit dependencies over hidden ordering assumptions. Mark independent write Tasks for worktree isolation and research-only Tasks as explore.

Never edit files or execute mutating commands. Return exactly the JSON shape requested by the user prompt without markdown or commentary.`

const PROMPT_WORK_ARCHITECT = `You are the read-only recovery architect for a durable software WorkGraph.

Inspect the current Task graph, failed evaluations, and workspace before proposing an additive recovery DAG. Replace only blocked Tasks, preserve their acceptance-criterion coverage, respect completed work, and address the concrete failure evidence instead of repeating the same approach.

Never edit files or execute mutating commands. Return exactly the JSON shape requested by the user prompt without markdown or commentary.`

const PROMPT_WORK_PM = `You are the Product Manager in a durable software WorkGraph organization.

Clarify the requested outcome, acceptance boundaries, dependencies, and product decisions for your assigned Task. Inspect the workspace when needed, consume only the routed Handoffs supplied to you, and produce concise evidence-backed guidance for downstream roles.

You are read-only. Never modify files, execute shell commands, delegate to another agent, or broaden the Goal. Finish with the structured Handoff requested by the Task prompt.`

const PROMPT_WORK_DESIGN_ARCHITECT = `You are the technical Architect in a durable software WorkGraph organization.

Inspect the relevant code and routed Handoffs, define explicit boundaries, constraints, interfaces, and tradeoffs, and identify risks before implementation. Architecture decisions must be concrete enough for a Developer to execute and must stay within the assigned Task.

You are read-only. Never modify files, execute shell commands, or delegate to another agent. Finish with the structured Handoff requested by the Task prompt.`

const PROMPT_WORK_DEVELOPER = `You are the Developer in a durable software WorkGraph organization.

Implement only the assigned Task in the current workspace. Treat routed Handoffs and the Role Contract as scoped inputs, preserve unrelated user changes, and produce concrete verification evidence. Do not create or coordinate other agents; WorkGraph owns decomposition and scheduling.

Finish with the structured Handoff requested by the Task prompt.`

const PROMPT_WORK_QA = `You are the independent Quality Engineer in a durable software WorkGraph organization.

Challenge the assigned behavior, acceptance criteria, implementation, and routed Handoffs. Inspect actual code and tests, identify missing cases and regressions, and report only evidence-backed findings. Deterministic command verification is owned by the WorkGraph runtime.

You are read-only. Never modify files, execute shell commands, or delegate to another agent. Finish with the structured Handoff requested by the Task prompt.`

const PROMPT_WORK_SECURITY = `You are the independent Security Engineer in a durable software WorkGraph organization.

Audit the assigned trust boundaries, permissions, data handling, and failure modes using the actual code and routed Handoffs. Distinguish verified vulnerabilities from hypotheses and state concrete constraints or mitigations.

You are read-only. Never modify files, execute shell commands, or delegate to another agent. Finish with the structured Handoff requested by the Task prompt.`

const PROMPT_COMPACTION = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`

const PROMPT_TITLE = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`

const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

export const Plugin = define({
  id: "agent",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const worktree = location.directory
    const whitelistedDirs = [TRUNCATION_GLOB, path.join(Global.Path.tmp, "*")]
    const readonlyExternalDirectory: PermissionV2.Ruleset = [
      { action: "external_directory", resource: "*", effect: "ask" },
      ...whitelistedDirs.map(
        (resource): PermissionV2.Rule => ({ action: "external_directory", resource, effect: "allow" }),
      ),
    ]
    const defaults: PermissionV2.Ruleset = [
      { action: "*", resource: "*", effect: "allow" },
      ...readonlyExternalDirectory,
      { action: "question", resource: "*", effect: "deny" },
      { action: "plan_enter", resource: "*", effect: "deny" },
      { action: "plan_exit", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]
    const unattendedWorkPermissions: PermissionV2.Ruleset = [
      { action: "question", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "read", resource: "*.env.*", effect: "deny" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]
    const readonlyWorkPermissions = PermissionV2.merge(
      defaults,
      [
        { action: "*", resource: "*", effect: "deny" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "read", resource: "*", effect: "allow" },
      ],
      readonlyExternalDirectory,
      unattendedWorkPermissions,
    )

    yield* ctx.agent.transform((draft) => {
      draft.update(AgentV2.defaultID, (item) => {
        item.description = "The default agent. Executes tools based on configured permissions."
        item.system ??= BUILD_SYSTEM
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "question", resource: "*", effect: "allow" },
            { action: "plan_enter", resource: "*", effect: "allow" },
          ]),
        )
      })

      draft.update(AgentV2.ID.make("plan"), (item) => {
        item.description = "Plan mode. Disallows all edit tools."
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "question", resource: "*", effect: "allow" },
            { action: "plan_exit", resource: "*", effect: "allow" },
            { action: "external_directory", resource: path.join(Global.Path.data, "plans", "*"), effect: "allow" },
            { action: "edit", resource: "*", effect: "deny" },
            { action: "edit", resource: path.join(".zaovra", "plans", "*.md"), effect: "allow" },
            {
              action: "edit",
              resource: path.relative(worktree, path.join(Global.Path.data, "plans", "*.md")),
              effect: "allow",
            },
          ]),
        )
      })

      draft.update(AgentV2.ID.make("general"), (item) => {
        item.description =
          "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."
        item.mode = "subagent"
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "todowrite", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("explore"), (item) => {
        item.description =
          'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'
        item.system = PROMPT_EXPLORE
        item.mode = "subagent"
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "websearch", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
            unattendedWorkPermissions,
          ),
        )
      })

      draft.update(AgentV2.ID.make("review"), (item) => {
        item.description = "Independent read-only reviewer for structured WorkGraph acceptance decisions."
        item.system = PROMPT_REVIEW
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
            unattendedWorkPermissions,
          ),
        )
      })

      draft.update(AgentV2.ID.make("work-planner"), (item) => {
        item.description = "Read-only structured planner for durable WorkGraph Task DAGs."
        item.system = PROMPT_WORK_PLANNER
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
            unattendedWorkPermissions,
          ),
        )
      })

      draft.update(AgentV2.ID.make("work-architect"), (item) => {
        item.description = "Read-only recovery architect for durable WorkGraph replanning."
        item.system = PROMPT_WORK_ARCHITECT
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
            unattendedWorkPermissions,
          ),
        )
      })

      draft.update(AgentV2.ID.make("work-pm"), (item) => {
        item.description = "Read-only Product Manager for scoped WorkGraph outcomes and decisions."
        item.system = PROMPT_WORK_PM
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(...readonlyWorkPermissions)
      })

      draft.update(AgentV2.ID.make("work-design-architect"), (item) => {
        item.description = "Read-only technical Architect for WorkGraph boundaries, contracts, and risks."
        item.system = PROMPT_WORK_DESIGN_ARCHITECT
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(...readonlyWorkPermissions)
      })

      draft.update(AgentV2.ID.make("work-developer"), (item) => {
        item.description = "Scoped implementation Agent owned and scheduled by WorkGraph."
        item.system = PROMPT_WORK_DEVELOPER
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "task", resource: "*", effect: "deny" },
              { action: "todowrite", resource: "*", effect: "deny" },
            ],
            unattendedWorkPermissions,
          ),
        )
      })

      draft.update(AgentV2.ID.make("work-qa"), (item) => {
        item.description = "Independent read-only Quality Engineer for WorkGraph Tasks."
        item.system = PROMPT_WORK_QA
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(...readonlyWorkPermissions)
      })

      draft.update(AgentV2.ID.make("work-security"), (item) => {
        item.description = "Independent read-only Security Engineer for WorkGraph Tasks."
        item.system = PROMPT_WORK_SECURITY
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(...readonlyWorkPermissions)
      })

      draft.update(AgentV2.ID.make("compaction"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_COMPACTION
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("title"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("summary"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })
    })
  }),
})
