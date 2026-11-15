import { describe, expect, it } from "vitest";
import {
  expandPromptVariables,
  type PromptVariableValues,
  promptClock,
} from "../../src/main/prompt-variables.js";

/**
 * The assistant system prompt's variables (D6).
 *
 * Two claims are worth more than the rest and are tested from both sides:
 *
 *  - **Nothing is invented.** An unknown name, and a known name with no value, stay as
 *    written. A system prompt that silently lost `{{user_name}}` would change the model's
 *    instructions without the user seeing a thing.
 *  - **The clock is an input.** Date and time come from a `Date` the caller passes, so
 *    "today" is testable without mocking the global clock and without a test that passes
 *    at 23:59 and fails at 00:01.
 */

const VALUES: PromptVariableValues = {
  date: "2026-11-15",
  time: "19:01",
  threadTitle: "Migrating the scheduler",
  projectName: "Platform",
};

describe("promptClock", () => {
  it("formats the injected instant as UTC date and time", () => {
    // The brief's own clock. UTC is the contract: everything else this app stores is
    // UTC, so an expansion cannot depend on which machine it ran on.
    expect(promptClock(new Date("2026-11-15T19:01:13.331Z"))).toEqual({
      date: "2026-11-15",
      time: "19:01",
    });
  });

  it("does not drift across midnight: 00:00 is a date and a time, not the day before", () => {
    expect(promptClock(new Date("2026-11-15T00:00:00.000Z"))).toEqual({
      date: "2026-11-15",
      time: "00:00",
    });
    expect(promptClock(new Date("2026-11-15T23:59:59.999Z"))).toEqual({
      date: "2026-11-15",
      time: "23:59",
    });
  });

  it("is deterministic for the same instant, twice", () => {
    const now = new Date("2026-02-29T06:07:08.000Z");
    expect(promptClock(now)).toEqual(promptClock(new Date(now.getTime())));
  });
});

describe("expandPromptVariables", () => {
  it("expands every known variable", () => {
    const template =
      "Today is {{date}} at {{time}}. Thread: {{thread_title}}. Project: {{project_name}}.";

    expect(expandPromptVariables(template, VALUES)).toBe(
      "Today is 2026-11-15 at 19:01. Thread: Migrating the scheduler. Project: Platform.",
    );
  });

  it("expands the same variable everywhere it appears", () => {
    expect(expandPromptVariables("{{date}} / {{date}}", VALUES)).toBe("2026-11-15 / 2026-11-15");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(expandPromptVariables("{{ date }}|{{  time  }}", VALUES)).toBe("2026-11-15|19:01");
  });

  it("leaves an unknown variable exactly as written", () => {
    // The rule that matters: a typo or a variable from another tool is not a licence to
    // blank the placeholder out. What the user wrote is what the model is given.
    expect(expandPromptVariables("Hi {{user_name}}, it is {{date}}.", VALUES)).toBe(
      "Hi {{user_name}}, it is 2026-11-15.",
    );
  });

  it("leaves a known variable literal when it has no value", () => {
    const noProject: PromptVariableValues = { ...VALUES, projectName: null };
    // An empty substitution would turn "Project: {{project_name}}" into "Project: " and
    // the prompt would read as if the thread had a project with a blank name.
    expect(expandPromptVariables("Project: {{project_name}}", noProject)).toBe(
      "Project: {{project_name}}",
    );
  });

  it("is case sensitive: an upper-case name is not a variable", () => {
    expect(expandPromptVariables("{{DATE}} {{Date}}", VALUES)).toBe("{{DATE}} {{Date}}");
  });

  it("leaves JSON, code fences and unmatched braces alone", () => {
    const template = '{"a": 1}\n```js\nif (x) { return y; }\n```\n{{unclosed and {{}}';
    expect(expandPromptVariables(template, VALUES)).toBe(template);
  });

  it("returns an empty template unchanged", () => {
    expect(expandPromptVariables("", VALUES)).toBe("");
  });

  it("does not re-expand a value that looks like a variable", () => {
    // A thread titled "{{date}}" is a title, not an instruction. One pass, no recursion:
    // otherwise a title could inject the clock (or anything else) into a prompt.
    const hostile: PromptVariableValues = { ...VALUES, threadTitle: "{{date}}" };
    expect(expandPromptVariables("Thread: {{thread_title}}", hostile)).toBe("Thread: {{date}}");
  });
});
