import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { resolveCallerAgentId as resolveRunCallerAgentId } from "../../utils/caller-agent.js";
import {
  resolveExistingRunWorkspace,
  runRunCommand,
  waitsForFinish,
  type AgentRunOptions,
} from "./run";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Answers fetchAgent the way a daemon does: an unknown id is an error.
function daemonWithAgents(...agentIds: string[]) {
  return {
    async fetchAgent({ agentId }: { agentId: string }) {
      if (!agentIds.includes(agentId)) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return { agent: { id: agentId } };
    },
  };
}

describe("run wait policy", () => {
  it("waits by default and stops waiting on --no-wait or a legacy alias", () => {
    expect(waitsForFinish({})).toBe(true);
    expect(waitsForFinish({ wait: false })).toBe(false);
    expect(waitsForFinish({ background: true })).toBe(false);
    expect(waitsForFinish({ detach: true })).toBe(false);
  });
});

describe("managed agent caller context", () => {
  it("uses a trimmed PASEO_AGENT_ID when the target daemon runs that agent", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("parent-agent"), {
        PASEO_AGENT_ID: "  parent-agent  ",
      }),
    ).resolves.toBe("parent-agent");
  });

  it("runs without a caller when PASEO_AGENT_ID belongs to another daemon", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("other-agent"), {
        PASEO_AGENT_ID: "parent-agent",
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"] as const)(
    "preserves %s instead of dropping the caller",
    async (code) => {
      const disconnectedDaemon = {
        async fetchAgent(): Promise<never> {
          throw new DaemonConnectionError("Caller lookup transport failed", code);
        },
      };

      await expect(
        resolveRunCallerAgentId(disconnectedDaemon, { PASEO_AGENT_ID: "parent-agent" }),
      ).rejects.toBeInstanceOf(DaemonConnectionError);
    },
  );

  it("omits blank caller ids", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents(), { PASEO_AGENT_ID: "   " }),
    ).resolves.toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        {} as never,
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});

const daemonMocks = vi.hoisted(() => ({
  connectToDaemon: vi.fn(),
  createWorkspace: vi.fn(),
  createAgent: vi.fn(),
  setWorkspaceTitle: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchAgent: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: daemonMocks.connectToDaemon,
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

const {
  connectToDaemon,
  createWorkspace,
  createAgent,
  setWorkspaceTitle,
  fetchWorkspaces,
  fetchAgent,
  close,
} = daemonMocks;

describe("run workspace titling", () => {
  const originalAgentId = process.env.PASEO_AGENT_ID;
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
  const prompt = "Fix the flaky checkout test";
  const title = "↳ 🛠️ Safety-classifier on CurveBender";
  const existingWorkspaceId = "wks_fedcba9876543210";

  beforeEach(() => {
    delete process.env.PASEO_AGENT_ID;
    delete process.env.PASEO_WORKSPACE_ID;

    connectToDaemon.mockReset();
    createWorkspace.mockReset();
    createAgent.mockReset();
    setWorkspaceTitle.mockReset();
    fetchWorkspaces.mockReset();
    fetchAgent.mockReset();
    close.mockReset();

    createWorkspace.mockResolvedValue({
      workspace: {
        id: "wks_0123456789abcdef",
        name: "Generated workspace",
        workspaceDirectory: "/project/new",
        gitRuntime: { currentBranch: "main" },
      },
      error: null,
    });
    createAgent.mockImplementation(
      async (input: { provider: string; cwd: string; title?: string }) => ({
        id: "agent-created",
        status: "idle",
        provider: input.provider,
        cwd: input.cwd,
        title: input.title ?? null,
      }),
    );
    fetchWorkspaces.mockImplementation(async ({ filter }: { filter: { query: string } }) => ({
      entries: [{ id: filter.query, workspaceDirectory: "/project/existing" }],
      pageInfo: { nextCursor: null },
    }));
    fetchAgent.mockImplementation(async ({ agentId }: { agentId: string }) => {
      if (agentId === process.env.PASEO_AGENT_ID) return { agent: { id: agentId } };
      throw new Error(`Agent not found: ${agentId}`);
    });
    close.mockResolvedValue(undefined);
    connectToDaemon.mockResolvedValue({
      createWorkspace,
      createAgent,
      setWorkspaceTitle,
      fetchWorkspaces,
      fetchAgent,
      close,
    });
  });

  afterEach(() => {
    if (originalAgentId === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = originalAgentId;
    if (originalWorkspaceId === undefined) delete process.env.PASEO_WORKSPACE_ID;
    else process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
  });

  function runWithoutWaiting(options: Omit<AgentRunOptions, "daemonTarget" | "provider" | "cwd">) {
    return runRunCommand(
      prompt,
      { ...options, provider: "codex", cwd: "/project", wait: false, daemonTarget },
      {} as never,
    );
  }

  it.each([
    ["bare", undefined],
    ["local", "local"],
    ["worktree", "worktree"],
  ] as const)("titles the workspace a %s run creates", async (_label, newWorkspace) => {
    await runWithoutWaiting({ newWorkspace, title });

    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        title,
        firstAgentContext: { prompt },
        source: expect.objectContaining({
          kind: newWorkspace === "worktree" ? "worktree" : "directory",
        }),
      }),
    );
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ title }));
  });

  it.each(["local", "worktree"] as const)(
    "gives the daemon prompt context for a %s workspace when no title is set",
    async (newWorkspace) => {
      await runWithoutWaiting({ newWorkspace });

      expect(createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ firstAgentContext: { prompt } }),
      );
      expect(createWorkspace.mock.calls[0][0]).not.toHaveProperty("title");
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ title: undefined }));
    },
  );

  it("does not retitle the workspace selected by --workspace", async () => {
    await runWithoutWaiting({ workspace: existingWorkspaceId, title });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(setWorkspaceTitle).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: existingWorkspaceId, title }),
    );
  });

  it("does not retitle the caller agent's workspace", async () => {
    process.env.PASEO_AGENT_ID = "parent-agent";

    await runWithoutWaiting({ title });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(setWorkspaceTitle).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ callerAgentId: "parent-agent", title }),
    );
  });

  it("does not retitle the PASEO_WORKSPACE_ID workspace", async () => {
    process.env.PASEO_WORKSPACE_ID = existingWorkspaceId;

    await runWithoutWaiting({ title });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(setWorkspaceTitle).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: existingWorkspaceId, title }),
    );
  });
});
