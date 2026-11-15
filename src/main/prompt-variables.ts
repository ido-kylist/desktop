/**
 * The variables an assistant's system prompt may carry, and their expansion.
 *
 * Pure on purpose: no database, no clock of its own. The caller decides what "now"
 * is and what the thread and project are called, which is what makes this testable
 * without freezing time globally — and what keeps one turn's expansion from leaking
 * into another's.
 *
 * Two rules the tests pin down:
 *
 *  - **Only the four known names are substituted.** Anything else — a typo, a
 *    template variable from another tool — is left exactly as written. A system
 *    prompt that says `{{user_name}}` keeps saying it, and the user can see why.
 *  - **A known name with no value is left as written too.** A thread in no project
 *    expands `{{project_name}}` to itself rather than to an empty string, so a prompt
 *    that reads "Project: {{project_name}}" cannot silently become "Project: ".
 *
 * Date and time are **UTC**, derived from the ISO string: everything else this app
 * stores and compares is UTC, and a formatter that silently used the machine's zone
 * would make the same prompt expand differently on two machines. A local-time
 * variant is in BACKLOG.md.
 */

export interface PromptClock {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** `HH:MM`, UTC, 24-hour. */
  time: string;
}

export function promptClock(now: Date): PromptClock {
  const iso = now.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export interface PromptVariableValues {
  date: string;
  time: string;
  threadTitle: string;
  /** Null when the thread belongs to no project. */
  projectName: string | null;
}

/** `{{ name }}` with optional inner whitespace; names are lowercase snake_case. */
const VARIABLE_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function expandPromptVariables(template: string, values: PromptVariableValues): string {
  return template.replace(VARIABLE_PATTERN, (match: string, name: string): string => {
    switch (name) {
      case "date":
        return values.date;
      case "time":
        return values.time;
      case "thread_title":
        return values.threadTitle;
      case "project_name":
        return values.projectName ?? match;
      default:
        // Unknown, or known-but-unavailable: the placeholder is the honest output.
        return match;
    }
  });
}
