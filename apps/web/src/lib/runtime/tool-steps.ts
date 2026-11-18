/** Shared per-run counter for maxToolStepsPerRun across load_skill and MCP tools. */
export function createToolStepGate(maxSteps: number) {
  let used = 0;
  return {
    tryConsume(): boolean {
      if (used >= maxSteps) return false;
      used += 1;
      return true;
    },
    get used() {
      return used;
    },
    get max() {
      return maxSteps;
    },
  };
}

export type ToolStepGate = ReturnType<typeof createToolStepGate>;
