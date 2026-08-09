const EXECUTION_POLICY_VERSION = "1.0";
const PROFILE_ID = /^[a-z][a-z0-9-]{1,63}$/;

const profiles = [
  {
    id: "answer-only",
    label: "Answer only",
    status: "available",
    risk: "green",
    default: true,
    capabilities: {
      filesystem: "none",
      network: "none",
      shell: false,
      apps: false,
      multi_agent: false,
      skills: "instruction-only",
    },
    retry: {
      preflight: 1,
      after_model_start: 0,
    },
    runtime: {
      sandbox: "read-only",
      codexConfigOverrides: [
        'approval_policy="never"',
        'history.persistence="save-all"',
        'sandbox_mode="read-only"',
        "features.apps=false",
        "features.hooks=false",
        "features.multi_agent=false",
        "features.remote_plugin=false",
        "features.shell_tool=false",
        "features.skill_mcp_dependency_install=false",
        "features.unified_exec=false",
        "tools.view_image=false",
        "tools.web_search=false",
        'web_search="disabled"',
      ],
    },
  },
  {
    id: "workspace-read",
    label: "Read selected workspace",
    status: "planned",
    risk: "yellow",
    default: false,
    capabilities: {
      filesystem: "selected-workspace-read-only",
      network: "none",
      shell: true,
      apps: false,
      multi_agent: false,
      skills: "local",
    },
    retry: {
      preflight: 1,
      after_model_start: 0,
    },
  },
  {
    id: "web-research",
    label: "Web research",
    status: "planned",
    risk: "orange",
    default: false,
    capabilities: {
      filesystem: "none",
      network: "web-search-only",
      shell: false,
      apps: false,
      multi_agent: false,
      skills: "instruction-only",
    },
    retry: {
      preflight: 1,
      after_model_start: 0,
    },
  },
];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

for (const profile of profiles) {
  if (!PROFILE_ID.test(profile.id)) {
    throw new Error(`Invalid execution profile id: ${profile.id}`);
  }
  if (profile.retry.after_model_start !== 0) {
    throw new Error(`${profile.id} must not retry after model start`);
  }
  if (profile.status === "available" && !profile.runtime) {
    throw new Error(`${profile.id} has no vetted runtime mapping`);
  }
  if (profile.status !== "available" && profile.runtime) {
    throw new Error(`${profile.id} exposes runtime flags before availability`);
  }
}

const defaults = profiles.filter((profile) => profile.default);
if (defaults.length !== 1 || defaults[0].status !== "available") {
  throw new Error("Exactly one available execution profile must be the default");
}

const EXECUTION_PROFILES = deepFreeze(profiles);
const DEFAULT_EXECUTION_PROFILE_ID = defaults[0].id;

class ExecutionProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionProfileError";
    this.code = code;
  }
}

function executionProfileCatalog() {
  return EXECUTION_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    status: profile.status,
    risk: profile.risk,
    default: profile.default,
    capabilities: profile.capabilities,
  }));
}

function resolveExecutionProfile(id = DEFAULT_EXECUTION_PROFILE_ID) {
  if (!PROFILE_ID.test(id || "")) {
    throw new ExecutionProfileError(
      "execution_profile_invalid",
      "execution_profile_id is invalid",
    );
  }
  const profile = EXECUTION_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) {
    throw new ExecutionProfileError(
      "execution_profile_unknown",
      "Execution profile is not recognized",
    );
  }
  if (profile.status !== "available") {
    throw new ExecutionProfileError(
      "execution_profile_unavailable",
      "Execution profile is not available in this bridge version",
    );
  }
  return profile;
}

export {
  DEFAULT_EXECUTION_PROFILE_ID,
  EXECUTION_POLICY_VERSION,
  EXECUTION_PROFILES,
  ExecutionProfileError,
  executionProfileCatalog,
  resolveExecutionProfile,
};
